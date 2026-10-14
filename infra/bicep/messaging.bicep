// Scan queue: Service Bus Standard namespace, one queue with dead-lettering, Entra auth only.
// Note: the Standard tier has no private endpoints and no IP/VNet rules (Premium only), so the
// namespace is reachable from the internet and protected by Entra RBAC alone. DESIGN §3 chose Standard.
targetScope = 'resourceGroup'

@description('Service Bus namespace name. Placeholder: <servicebus-namespace>.')
param name string

param location string = resourceGroup().location

param queueName string = 'artifact-scan'

@description('Object id of the intake-api workload identity (sender). Empty skips the assignment.')
param intakeApiPrincipalId string = ''

@description('Object id of the scanner-worker workload identity (receiver).')
param scannerPrincipalId string = ''

var dataSender = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var dataReceiver = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0')

resource namespace 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: name
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    disableLocalAuth: true // no SAS keys anywhere
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled' // Standard tier cannot be disabled; Premium would allow a private endpoint
  }
}

resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: namespace
  name: queueName
  properties: {
    lockDuration: 'PT5M' // a scan takes seconds; 5 min covers the 60 s Defender wait with margin
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: true
    defaultMessageTimeToLive: 'P1D'
    requiresDuplicateDetection: true // message id = jobId, so a double enqueue is dropped
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    maxSizeInMegabytes: 1024
    enablePartitioning: false
  }
}

resource raSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(intakeApiPrincipalId)) {
  name: guid(queue.id, intakeApiPrincipalId, dataSender)
  scope: queue
  properties: { principalId: intakeApiPrincipalId, roleDefinitionId: dataSender, principalType: 'ServicePrincipal' }
}

resource raReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(scannerPrincipalId)) {
  name: guid(queue.id, scannerPrincipalId, dataReceiver)
  scope: queue
  properties: { principalId: scannerPrincipalId, roleDefinitionId: dataReceiver, principalType: 'ServicePrincipal' }
}

output namespaceId string = namespace.id
output fullyQualifiedNamespace string = '${namespace.name}.servicebus.windows.net'
output queueName string = queue.name
