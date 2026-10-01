// Nova tutor backend - Azure infrastructure (PRD §6).
// Deploy once per environment:
//   az group create -n rg-nova-<env> -l centralindia
//   az deployment group create -g rg-nova-<env> -f infra/main.bicep -p infra/<env>.bicepparam
//
// Region split (verified against Microsoft region tables, Sept 2026):
//   - Speech, Storage, PostgreSQL, Redis, Container Apps: Central India (Speech is NOT offered in South India).
//   - Azure OpenAI + Content Safety: South India (not listed for Central India).
// Both regions are in India; traffic between them stays on the Microsoft backbone.

targetScope = 'resourceGroup'

@allowed(['dev', 'staging', 'prod'])
param env string
param primaryLocation string = 'centralindia'
param aiLocation string = 'southindia'
param namePrefix string = 'nova'
param containerImage string
@secure()
param postgresAdminPassword string
param postgresAdminUser string = 'novaadmin'
@minValue(1)
@maxValue(90)
param audioRetentionDays int = 30

// Model deployments. Defaults follow docs/AZURE_REQUIREMENTS.md; change here if quota/region differs.
// `version` is omitted so the model's current default version is used; pin it per environment in the .bicepparam.
// capacity = thousands of tokens per minute (TPM).
param tutorModel object = { name: 'gpt-5.4-mini', sku: 'DataZoneStandard', capacity: 200 }
param summaryModel object = { name: 'gpt-5.4', sku: 'DataZoneStandard', capacity: 50 }

var tutorModelSpec = union({ format: 'OpenAI', name: tutorModel.name }, contains(tutorModel, 'version') ? { version: tutorModel.version } : {})
var summaryModelSpec = union({ format: 'OpenAI', name: summaryModel.name }, contains(summaryModel, 'version') ? { version: summaryModel.version } : {})

var suffix = '${namePrefix}-${env}-${uniqueString(resourceGroup().id)}'
var short = toLower(replace('${namePrefix}${env}${uniqueString(resourceGroup().id)}', '-', ''))
var tags = { app: 'nova-tutor', env: env }

// ---------------------------------------------------------------- observability
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${suffix}'
  location: primaryLocation
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${suffix}'
  location: primaryLocation
  kind: 'web'
  tags: tags
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, DisableIpMasking: false }
}

// ---------------------------------------------------------------- identity
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${suffix}'
  location: primaryLocation
  tags: tags
}

// ---------------------------------------------------------------- AI services
resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'spch-${suffix}'
  location: primaryLocation
  kind: 'SpeechServices'
  sku: { name: 'S0' }
  tags: tags
  properties: {
    customSubDomainName: 'spch-${short}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: env == 'prod' // prod uses Entra ID (managed identity) only
  }
}

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'oai-${suffix}'
  location: aiLocation
  kind: 'OpenAI'
  sku: { name: 'S0' }
  tags: tags
  properties: {
    customSubDomainName: 'oai-${short}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: env == 'prod'
  }
}

// Stricter content filter for learners in the kids age band (PRD §12). Blocks low severity and up.
resource kidsFilter 'Microsoft.CognitiveServices/accounts/raiPolicies@2024-10-01' = {
  parent: openai
  name: 'kids-strict'
  properties: {
    basePolicyName: 'Microsoft.DefaultV2'
    mode: 'Asynchronous_filter'
    contentFilters: [for f in [
      { name: 'Hate', source: 'Prompt' }, { name: 'Hate', source: 'Completion' }
      { name: 'Sexual', source: 'Prompt' }, { name: 'Sexual', source: 'Completion' }
      { name: 'Violence', source: 'Prompt' }, { name: 'Violence', source: 'Completion' }
      { name: 'Selfharm', source: 'Prompt' }, { name: 'Selfharm', source: 'Completion' }
    ]: { name: f.name, source: f.source, enabled: true, blocking: true, severityThreshold: 'Low' }]
  }
}

resource tutorDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'tutor-fast'
  sku: { name: tutorModel.sku, capacity: tutorModel.capacity }
  properties: { model: tutorModelSpec, raiPolicyName: 'Microsoft.DefaultV2' }
}

resource kidsDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'tutor-kids'
  sku: { name: tutorModel.sku, capacity: tutorModel.capacity }
  properties: { model: tutorModelSpec, raiPolicyName: kidsFilter.name }
  dependsOn: [tutorDeployment] // deployments on one account must be created sequentially
}

resource summaryDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'tutor-summary'
  sku: { name: summaryModel.sku, capacity: summaryModel.capacity }
  properties: { model: summaryModelSpec, raiPolicyName: 'Microsoft.DefaultV2' }
  dependsOn: [kidsDeployment]
}

resource contentSafety 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'cs-${suffix}'
  location: aiLocation
  kind: 'ContentSafety'
  sku: { name: 'S0' }
  tags: tags
  properties: { customSubDomainName: 'cs-${short}', publicNetworkAccess: 'Enabled', disableLocalAuth: env == 'prod' }
}

// ---------------------------------------------------------------- data
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('st${short}', 24)
  location: primaryLocation
  kind: 'StorageV2'
  sku: { name: env == 'prod' ? 'Standard_ZRS' : 'Standard_LRS' }
  tags: tags
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    encryption: { services: { blob: { enabled: true } }, keySource: 'Microsoft.Storage' }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource audioContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'learner-audio'
  properties: { publicAccess: 'None' }
}

// Backstop for the in-app retention job: consented audio is deleted after N days regardless.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-learner-audio'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['learner-audio/'] }
            actions: { baseBlob: { delete: { daysAfterCreationGreaterThan: audioRetentionDays } } }
          }
        }
      ]
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-${suffix}'
  location: primaryLocation
  tags: tags
  sku: env == 'prod' ? { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' } : { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: postgresAdminUser
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' } // keep backups in-country
    highAvailability: { mode: env == 'prod' ? 'ZoneRedundant' : 'Disabled' }
  }
}

resource postgresDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'nova'
}

resource postgresAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// Azure Managed Redis (successor to Azure Cache for Redis).
resource redis 'Microsoft.Cache/redisEnterprise@2024-10-01' = {
  name: 'redis-${suffix}'
  location: primaryLocation
  tags: tags
  sku: { name: env == 'prod' ? 'Balanced_B1' : 'Balanced_B0' }
  properties: { minimumTlsVersion: '1.2' }
}

resource redisDb 'Microsoft.Cache/redisEnterprise/databases@2024-10-01' = {
  parent: redis
  name: 'default'
  properties: { clientProtocol: 'Encrypted', port: 10000, clusteringPolicy: 'EnterpriseCluster', evictionPolicy: 'VolatileLRU' }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('kv-${short}', 24)
  location: primaryLocation
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
  }
}

resource dbUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'database-url'
  properties: { value: 'postgres://${postgresAdminUser}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/nova' }
}

resource redisUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'redis-url'
  properties: { value: 'rediss://:${redisDb.listKeys().primaryKey}@${redis.properties.hostName}:10000' }
}

// ---------------------------------------------------------------- RBAC for the app identity
var roles = {
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
  cognitiveServicesOpenAIUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
}

resource speechRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(speech.id, appIdentity.id, roles.cognitiveServicesUser)
  scope: speech
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesUser) }
}

resource openaiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openai.id, appIdentity.id, roles.cognitiveServicesOpenAIUser)
  scope: openai
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesOpenAIUser) }
}

resource safetyRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(contentSafety.id, appIdentity.id, roles.cognitiveServicesUser)
  scope: contentSafety
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesUser) }
}

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, appIdentity.id, roles.storageBlobDataContributor)
  scope: storage
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor) }
}

resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, appIdentity.id, roles.keyVaultSecretsUser)
  scope: keyVault
  properties: { principalId: appIdentity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser) }
}

// ---------------------------------------------------------------- compute
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${suffix}'
  location: primaryLocation
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logs.properties.customerId, sharedKey: logs.listKeys().primarySharedKey }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${suffix}'
  location: primaryLocation
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appIdentity.id}': {} } }
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: { external: true, targetPort: 8080, transport: 'http', allowInsecure: false }
      secrets: [
        { name: 'database-url', keyVaultUrl: dbUrlSecret.properties.secretUri, identity: appIdentity.id }
        { name: 'redis-url', keyVaultUrl: redisUrlSecret.properties.secretUri, identity: appIdentity.id }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: containerImage
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AZURE_CLIENT_ID', value: appIdentity.properties.clientId }
            { name: 'AZURE_SPEECH_REGION', value: primaryLocation }
            { name: 'AZURE_SPEECH_ENDPOINT', value: speech.properties.endpoint }
            { name: 'AZURE_OPENAI_ENDPOINT', value: openai.properties.endpoint }
            { name: 'AZURE_OPENAI_TUTOR_DEPLOYMENT', value: tutorDeployment.name }
            { name: 'AZURE_OPENAI_KIDS_DEPLOYMENT', value: kidsDeployment.name }
            { name: 'AZURE_OPENAI_SUMMARY_DEPLOYMENT', value: summaryDeployment.name }
            { name: 'AZURE_OPENAI_REASONING_EFFORT', value: 'none' }
            { name: 'AZURE_CONTENT_SAFETY_ENDPOINT', value: contentSafety.properties.endpoint }
            { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'AUDIO_RETENTION_DAYS', value: string(audioRetentionDays) }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DATABASE_SSL', value: 'true' }
            { name: 'REDIS_URL', secretRef: 'redis-url' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/healthz', port: 8080 } }
            { type: 'Readiness', httpGet: { path: '/readyz', port: 8080 } }
          ]
        }
      ]
      // Keep replicas warm (PRD §11 "warm connections"); scale on concurrent connections.
      scale: {
        minReplicas: env == 'prod' ? 2 : 1
        maxReplicas: env == 'prod' ? 20 : 3
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
  dependsOn: [kvRole, speechRole, openaiRole, safetyRole, storageRole]
}

output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output speechEndpoint string = speech.properties.endpoint
output openaiEndpoint string = openai.properties.endpoint
output contentSafetyEndpoint string = contentSafety.properties.endpoint
