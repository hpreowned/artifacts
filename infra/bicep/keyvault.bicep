// Key Vault for the platform. RBAC authorization, purge protection, optional private endpoint.
// Bicep creates NO secrets. People create these four secrets and import the two certificates:
//   secrets:      view-token-key, pipeline-token, internal-shared-key, entra-shell-client-secret
//   certificates: artifacts-corp-com-tls, wildcard-corp-artifacts-net-tls   (see infra/README.md)
targetScope = 'resourceGroup'

@description('Key Vault name, 3-24 alphanumerics and dashes. Placeholder: <keyvault-name>.')
@minLength(3)
@maxLength(24)
param name string

param location string = resourceGroup().location

param tenantId string = subscription().tenantId

@description('Subnet id for the vault private endpoint. Empty = none.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id for privatelink.vaultcore.azure.net. Empty = no DNS zone group.')
param vaultPrivateDnsZoneId string = ''

@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = 'Disabled'

@description('Object ids that may READ secrets (Key Vault Secrets User): the workload identities behind the SecretProviderClasses in deploy/platform/. Certificates are read in their secret form, so this one role covers both.')
param secretReaderPrincipalIds array = []

@description('Object id of the person or group who creates the secrets and imports the certificates (Secrets Officer + Certificates Officer).')
param keyVaultAdminPrincipalId string = ''

@description('Object id of the Azure DevOps service connection principal that reads pipeline-token through the Key Vault-linked variable group.')
param pipelinePrincipalId string = ''

var secretsUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretsOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
var certificatesOfficer = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a4417e6f-fecd-4de8-b567-7b0420556985')

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: name
  location: location
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!empty(privateEndpointSubnetId)) {
  name: '${name}-vault-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      { name: 'vault', properties: { privateLinkServiceId: vault.id, groupIds: ['vault'] } }
    ]
  }

  resource dnsZoneGroup 'privateDnsZoneGroups' = if (!empty(vaultPrivateDnsZoneId)) {
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        { name: 'vault', properties: { privateDnsZoneId: vaultPrivateDnsZoneId } }
      ]
    }
  }
}

resource raReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in secretReaderPrincipalIds: {
  name: guid(vault.id, principalId, secretsUser)
  scope: vault
  properties: { principalId: principalId, roleDefinitionId: secretsUser, principalType: 'ServicePrincipal' }
}]

resource raPipeline 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(pipelinePrincipalId)) {
  name: guid(vault.id, pipelinePrincipalId, secretsUser)
  scope: vault
  properties: { principalId: pipelinePrincipalId, roleDefinitionId: secretsUser, principalType: 'ServicePrincipal' }
}

resource raAdminSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultAdminPrincipalId)) {
  name: guid(vault.id, keyVaultAdminPrincipalId, secretsOfficer)
  scope: vault
  properties: { principalId: keyVaultAdminPrincipalId, roleDefinitionId: secretsOfficer }
}

resource raAdminCerts 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultAdminPrincipalId)) {
  name: guid(vault.id, keyVaultAdminPrincipalId, certificatesOfficer)
  scope: vault
  properties: { principalId: keyVaultAdminPrincipalId, roleDefinitionId: certificatesOfficer }
}

output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
