using './main.bicep'

param env = 'dev'
param containerImage = 'ghcr.io/your-org/nova-tutor-backend:latest'
param postgresAdminPassword = readEnvironmentVariable('NOVA_PG_PASSWORD')
param tutorModel = { name: 'gpt-5.4-mini', sku: 'DataZoneStandard', capacity: 50 }
param summaryModel = { name: 'gpt-5.4', sku: 'DataZoneStandard', capacity: 20 }
