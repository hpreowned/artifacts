// Resource-group deployment of the three platform modules. APIM is a separate module (infra/apim/)
// because it targets an existing APIM instance owned by another team.
//   az deployment group create -g <resource-group> -f infra/bicep/main.bicep -p infra/bicep/main.example.bicepparam
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param storageAccountName string
param serviceBusNamespaceName string
param keyVaultName string

param privateEndpointSubnetId string = ''
param blobPrivateDnsZoneId string = ''
param vaultPrivateDnsZoneId string = ''

param defenderCapGBPerMonth int = 50

param intakeApiPrincipalId string = ''
param scannerPrincipalId string = ''
param staticGatewayPrincipalId string = ''
param viewerShellPrincipalId string = ''
param tlsSyncPrincipalId string = ''
param pipelinePrincipalId string = ''
param keyVaultAdminPrincipalId string = ''

var publicNetworkAccess = empty(privateEndpointSubnetId) ? 'Enabled' : 'Disabled'

module storage 'storage.bicep' = {
  name: 'artifacts-storage'
  params: {
    name: storageAccountName
    location: location
    privateEndpointSubnetId: privateEndpointSubnetId
    blobPrivateDnsZoneId: blobPrivateDnsZoneId
    publicNetworkAccess: publicNetworkAccess
    defenderCapGBPerMonth: defenderCapGBPerMonth
    intakeApiPrincipalId: intakeApiPrincipalId
    scannerPrincipalId: scannerPrincipalId
    staticGatewayPrincipalId: staticGatewayPrincipalId
    pipelinePrincipalId: pipelinePrincipalId
  }
}

module messaging 'messaging.bicep' = {
  name: 'artifacts-messaging'
  params: {
    name: serviceBusNamespaceName
    location: location
    intakeApiPrincipalId: intakeApiPrincipalId
    scannerPrincipalId: scannerPrincipalId
  }
}

module keyvault 'keyvault.bicep' = {
  name: 'artifacts-keyvault'
  params: {
    name: keyVaultName
    location: location
    privateEndpointSubnetId: privateEndpointSubnetId
    vaultPrivateDnsZoneId: vaultPrivateDnsZoneId
    publicNetworkAccess: publicNetworkAccess
    secretReaderPrincipalIds: filter([intakeApiPrincipalId, staticGatewayPrincipalId, viewerShellPrincipalId, tlsSyncPrincipalId], id => !empty(id))
    keyVaultAdminPrincipalId: keyVaultAdminPrincipalId
    pipelinePrincipalId: pipelinePrincipalId
  }
}

output storageAccountName string = storage.outputs.storageAccountName
output serviceBusFqdn string = messaging.outputs.fullyQualifiedNamespace
output keyVaultName string = keyvault.outputs.vaultName
