// Copy to main.bicepparam and replace every <placeholder>. Principal ids are Entra object ids of
// user-assigned managed identities (workload identity) or service principals, never client ids.
using './main.bicep'

param storageAccountName = '<storage-account>'
param serviceBusNamespaceName = '<servicebus-namespace>'
param keyVaultName = '<keyvault-name>'

param privateEndpointSubnetId = '<private-endpoint-subnet-resource-id>'
param blobPrivateDnsZoneId = '<privatelink.blob.core.windows.net-zone-resource-id>'
param vaultPrivateDnsZoneId = '<privatelink.vaultcore.azure.net-zone-resource-id>'

param defenderCapGBPerMonth = 50

param intakeApiPrincipalId = '<intake-api-identity-object-id>'
param scannerPrincipalId = '<scanner-worker-identity-object-id>'
param staticGatewayPrincipalId = '<blobfuse-node-identity-object-id>'
param viewerShellPrincipalId = '<viewer-shell-identity-object-id>'
param tlsSyncPrincipalId = '<tls-sync-identity-object-id>'
param pipelinePrincipalId = '<ado-storage-connection-principal-object-id>'
param keyVaultAdminPrincipalId = '<secrets-admin-object-id>'
