import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { UtteranceAssessment } from '../../domain/types.js';
import { emptyAssessment, mergeDetail, mergeSegments, parseAzureSegment } from './assessmentParser.js';
import { createSpeechConfig } from './speechConfig.js';
import type { RecognitionEvents, RecognitionOptions, SpeechRecognizerProvider, StreamingRecognition } from './types.js';

const PRIMARY_LOCALE = 'en-IN';
const DETAIL_LOCALE = 'en-US';
const STOP_TIMEOUT_MS = 2_500;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Lane {
  locale: string;
  recognizer: sdk.SpeechRecognizer;
  stream: sdk.PushAudioInputStream;
  segments: UtteranceAssessment[];
  stopped: Promise<void>;
  closing?: Promise<void>;
}

/**
 * Azure AI Speech streaming recognition with Pronunciation Assessment.
 *
 * Two lanes consume the same PCM:
 *  - en-IN (primary, critical path): transcript, partials for live captions, word accuracy,
 *    fluency, completeness. Accent-tolerant.
 *  - en-US (detail, optional): the same audio assessed for IPA phoneme names, NBest "heard"
 *    phonemes and prosody, which Microsoft supports only for en-US. It must finish within
 *    PRON_DETAIL_GRACE_MS of the primary lane or the turn proceeds without it.
 */
export class AzureSpeechRecognizer implements SpeechRecognizerProvider {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
    private readonly calibration: number,
  ) {}

  async start(opts: RecognitionOptions, events: RecognitionEvents): Promise<StreamingRecognition> {
    const primary = this.createLane(PRIMARY_LOCALE, opts, events, true);
    const detail = this.env.PRON_DETAIL_MODE === 'dual' ? this.createLane(DETAIL_LOCALE, opts, events, false) : null;
    await Promise.all([startLane(primary), detail ? startLane(detail).catch((err) => this.log.warn({ err }, 'detail lane failed to start')) : null]);

    let finished: Promise<UtteranceAssessment> | null = null;
    const finish = (): Promise<UtteranceAssessment> => {
      finished ??= (async () => {
        primary.stream.close();
        detail?.stream.close();
        // Closing the push stream flushes the last segment and ends the session; guard against a hung service.
        await Promise.race([primary.stopped, delay(STOP_TIMEOUT_MS).then(() => closeLane(primary))]);
        const primaryResult = mergeSegments(primary.segments, PRIMARY_LOCALE);
        let detailResult: UtteranceAssessment | null = null;
        if (detail && primaryResult.words.length) {
          const inTime = await Promise.race([
            detail.stopped.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), this.env.PRON_DETAIL_GRACE_MS)),
          ]);
          if (inTime) detailResult = mergeSegments(detail.segments, DETAIL_LOCALE);
          else this.log.info({ graceMs: this.env.PRON_DETAIL_GRACE_MS }, 'pronunciation detail lane missed grace window');
        }
        void closeLane(primary);
        if (detail) void detail.stopped.finally(() => closeLane(detail));
        return primaryResult.words.length || primaryResult.text
          ? mergeDetail(primaryResult, detailResult, this.calibration)
          : emptyAssessment(PRIMARY_LOCALE);
      })();
      return finished;
    };

    return {
      write(pcm: Buffer) {
        const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        primary.stream.write(ab);
        detail?.stream.write(ab.slice(0));
      },
      finish,
      cancel() {
        primary.stream.close();
        detail?.stream.close();
        void closeLane(primary);
        if (detail) void closeLane(detail);
      },
    };
  }

  private createLane(locale: string, opts: RecognitionOptions, events: RecognitionEvents, isPrimary: boolean): Lane {
    const config = createSpeechConfig(this.env);
    config.speechRecognitionLanguage = locale;
    config.outputFormat = sdk.OutputFormat.Detailed;
    if (isPrimary && this.env.AZURE_SPEECH_CUSTOM_ENDPOINT_ID) config.endpointId = this.env.AZURE_SPEECH_CUSTOM_ENDPOINT_ID;
    config.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(opts.segmentationSilenceMs));
    config.requestWordLevelTimestamps();

    const format = sdk.AudioStreamFormat.getWaveFormatPCM(16_000, 16, 1);
    const stream = sdk.AudioInputStream.createPushStream(format);
    const recognizer = new sdk.SpeechRecognizer(config, sdk.AudioConfig.fromStreamInput(stream));

    const pa = new sdk.PronunciationAssessmentConfig(
      opts.referenceText ?? '',
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      Boolean(opts.referenceText), // miscue only meaningful for scripted drills
    );
    if (locale === 'en-US') {
      // en-US-only features (Microsoft docs): IPA names, NBest spoken phonemes, prosody.
      pa.phonemeAlphabet = 'IPA';
      pa.nbestPhonemeCount = 3;
      pa.enableProsodyAssessment = opts.prosody;
    }
    pa.applyTo(recognizer);

    if (opts.phrases.length) sdk.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(opts.phrases);

    const segments: UtteranceAssessment[] = [];
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((r) => (resolveStopped = r));

    if (isPrimary) {
      recognizer.recognizing = (_s, e) => {
        if (e.result.text) events.onPartial(e.result.text);
      };
    }
    recognizer.recognized = (_s, e) => {
      if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      const json = e.result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult);
      const seg = json ? parseAzureSegment(json, locale) : null;
      if (!seg) return;
      segments.push(seg);
      if (isPrimary) events.onSegment(seg);
    };
    recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        const retryable = e.errorCode !== sdk.CancellationErrorCode.AuthenticationFailure && e.errorCode !== sdk.CancellationErrorCode.BadRequestParameters;
        if (isPrimary) events.onError(new Error(`speech ${sdk.CancellationErrorCode[e.errorCode]}: ${e.errorDetails}`), retryable);
        else this.log.warn({ code: e.errorCode, details: e.errorDetails }, 'detail lane canceled');
      }
      resolveStopped();
    };
    recognizer.sessionStopped = () => resolveStopped();

    return { locale, recognizer, stream, segments, stopped };
  }
}

function startLane(lane: Lane): Promise<void> {
  return new Promise((resolve, reject) => lane.recognizer.startContinuousRecognitionAsync(resolve, (e) => reject(new Error(e))));
}

/** Idempotent: stop + dispose the recogniser exactly once. */
function closeLane(lane: Lane): Promise<void> {
  lane.closing ??= new Promise((resolve) => {
    const close = () => {
      try {
        lane.recognizer.close(() => resolve(), () => resolve());
      } catch {
        resolve();
      }
    };
    try {
      lane.recognizer.stopContinuousRecognitionAsync(close, close);
    } catch {
      close();
    }
  });
  return lane.closing;
}
