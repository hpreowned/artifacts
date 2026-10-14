// Artifact storage: one StorageV2 account, three private containers, Defender for Storage
// on-upload malware scanning capped per month, serving/ excluded from scanning.
// Tenant-specific values are parameters; nothing here is a real name.
targetScope = 'resourceGroup'

@description('Storage account name, 3-24 lowercase alphanumerics. Placeholder: <storage-account>.')
@minLength(3)
@maxLength(24)
param name string

param location string = resourceGroup().location

@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS'])
param skuName string = 'Standard_ZRS'

@description('Subnet id for the blob private endpoint. Empty = no private endpoint (laptop/dev only).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.blob.core.windows.net. Empty = no DNS zone group.')
param blobPrivateDnsZoneId string = ''

@description('Set Disabled once the private endpoint exists.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Disabled'

@description('Defender for Storage on-upload scanning cap, GB per calendar month. -1 = uncapped. 50 GB covers thousands of 25 MiB bundles.')
param defenderCapGBPerMonth int = 50

@description('Blob prefixes excluded from on-upload scanning. Format container/prefix; a trailing slash limits the match to that one container.')
param defenderExcludePrefixes array = ['serving/']

@description('Optional Event Grid custom topic id that receives scan results (production path, DESIGN §5). Empty = index tags only.')
param scanResultsEventGridTopicId string = ''

@description('Object id of the intake-api workload identity. Empty skips the role assignment.')
param intakeApiPrincipalId string = ''
@description('Object id of the scanner-worker workload identity.')
param scannerPrincipalId string = ''
@description('Object id of the identity blobfuse uses for the static gateway mount (kubelet identity or a UAMI on the node VMSS).')
param staticGatewayPrincipalId string = ''
@description('Object id of the Azure DevOps storage service connection principal (Fetch stage reads intake, GC deletes serving).')
param pipelinePrincipalId string = ''

var blobDataContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var blobDataReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  kind: 'StorageV2'
  sku: { name: skuName }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // Entra only: workload identity, blobfuse MSI, az --auth-mode login
    allowCrossTenantReplication: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices' // Defender's StorageDataScanner is added to the account automatically
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

resource intakeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'intake'
  properties: { publicAccess: 'None' }
}

resource servingContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'serving'
  properties: { publicAccess: 'None' }
}

resource jobsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'jobs'
  properties: { publicAccess: 'None' }
}

// Defender for Storage, account level. Resource shape verified against
// learn.microsoft.com/azure/templates/microsoft.security/2025-06-01/defenderforstoragesettings (2026-10-14).
// Prerequisite: Microsoft.EventGrid provider registered in the subscription.
resource defender 'Microsoft.Security/defenderForStorageSettings@2025-06-01' = {
  name: 'current'
  scope: storage
  properties: {
    isEnabled: true
    overrideSubscriptionLevelSettings: true
    malwareScanning: {
      blobScanResultsOptions: 'blobIndexTags' // the worker polls the index tag in the POC (DESIGN §5)
      onUpload: {
        isEnabled: true
        capGBPerMonth: defenderCapGBPerMonth
        filters: {
          excludeBlobsWithPrefix: defenderExcludePrefixes
        }
      }
      scanResultsEventGridTopicResourceId: empty(scanResultsEventGridTopicId) ? null : scanResultsEventGridTopicId
    }
    sensitiveDataDiscovery: { isEnabled: false }
  }
}

// Private endpoint for blob, optional.
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!empty(privateEndpointSubnetId)) {
  name: '${name}-blob-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: { privateLinkServiceId: storage.id, groupIds: ['blob'] }
      }
    ]
  }

  resource dnsZoneGroup 'privateDnsZoneGroups' = if (!empty(blobPrivateDnsZoneId)) {
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        { name: 'blob', properties: { privateDnsZoneId: blobPrivateDnsZoneId } }
      ]
    }
  }
}

// Role assignments, container scoped. intake-api: write intake + jobs. scanner: read intake, write serving + jobs.
// static gateway identity: read serving. pipeline: read intake, delete in serving (GC).
resource raIntakeApiIntake 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(intakeApiPrincipalId)) {
  name: guid(intakeContainer.id, intakeApiPrincipalId, blobDataContributor)
  scope: intakeContainer
  properties: { principalId: intakeApiPrincipalId, roleDefinitionId: blobDataContributor, principalType: 'ServicePrincipal' }
}

resource raIntakeApiJobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(intakeApiPrincipalId)) {
  name: guid(jobsContainer.id, intakeApiPrincipalId, blobDataContributor)
  scope: jobsContainer
  properties: { principalId: intakeApiPrincipalId, roleDefinitionId: blobDataContributor, principalType: 'ServicePrincipal' }
}

resource raScannerIntake 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(scannerPrincipalId)) {
  name: guid(intakeContainer.id, scannerPrincipalId, blobDataReader)
  scope: intakeContainer
  properties: { principalId: scannerPrincipalId, roleDefinitionId: blobDataReader, principalType: 'ServicePrincipal' }
}

resource raScannerServing 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(scannerPrincipalId)) {
  name: guid(servingContainer.id, scannerPrincipalId, blobDataContributor)
  scope: servingContainer
  properties: { principalId: scannerPrincipalId, roleDefinitionId: blobDataContributor, principalType: 'ServicePrincipal' }
}

resource raScannerJobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(scannerPrincipalId)) {
  name: guid(jobsContainer.id, scannerPrincipalId, blobDataContributor)
  scope: jobsContainer
  properties: { principalId: scannerPrincipalId, roleDefinitionId: blobDataContributor, principalType: 'ServicePrincipal' }
}

resource raStaticGatewayServing 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(staticGatewayPrincipalId)) {
  name: guid(servingContainer.id, staticGatewayPrincipalId, blobDataReader)
  scope: servingContainer
  properties: { principalId: staticGatewayPrincipalId, roleDefinitionId: blobDataReader, principalType: 'ServicePrincipal' }
}

resource raPipelineIntake 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pipelinePrincipalId)) {
  name: guid(intakeContainer.id, pipelinePrincipalId, blobDataReader)
  scope: intakeContainer
  properties: { principalId: pipelinePrincipalId, roleDefinitionId: blobDataReader, principalType: 'ServicePrincipal' }
}

resource raPipelineServing 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pipelinePrincipalId)) {
  name: guid(servingContainer.id, pipelinePrincipalId, blobDataContributor)
  scope: servingContainer
  properties: { principalId: pipelinePrincipalId, roleDefinitionId: blobDataContributor, principalType: 'ServicePrincipal' }
}

output storageAccountId string = storage.id
output storageAccountName string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
