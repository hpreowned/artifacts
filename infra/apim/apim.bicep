// APIM configuration for Publish-to-AKS, applied to an EXISTING APIM instance (Developer..Premium v2, not Consumption):
//   1. REST API "artifacts" imported from contracts/intake-openapi.yaml, backend = intake-api
//   2. MCP server "artifacts-mcp" over the two x-mcp-tool operations     (UNVERIFIED shape, see README)
//   3. PRM operation GET /.well-known/oauth-protected-resource/artifacts-mcp/mcp
//   4. named values tenant-id, artifacts-mcp-client-id, claude-connector-client-id
//   5. policies: MCP scope (DESIGN §6.10), REST Entra, upload/finalize, internal 404
targetScope = 'resourceGroup'

@description('Existing APIM service name. Placeholder: <apim-name>.')
param apimName string

@description('Backend URL of intake-api as APIM reaches it over the VNet, e.g. https://intake.artifacts.internal (DESIGN §6.11).')
param backendUrl string

@description('Public hostname Claude and the Cowork sandbox use. The policy files say mcp.corp.com; it is replaced here.')
param publicHostname string = 'mcp.corp.com'

@description('Entra tenant id.')
param tenantId string

@description('Client (application) id of the artifacts-mcp app registration (token audience).')
param artifactsMcpClientId string

@description('Client (application) id of the claude-connector app registration.')
param claudeConnectorClientId string

@description('internal = APIM behind App Gateway (IP decisions in the WAF). external = APIM public, ip-filter policy applied.')
@allowed(['internal', 'external'])
param apimMode string = 'internal'

param restApiName string = 'artifacts'
param mcpServerName string = 'artifacts-mcp'

var mcpPolicyFile = apimMode == 'external' ? loadTextContent('policies/mcp-server-external.xml') : loadTextContent('policies/mcp-server.xml')
var mcpPolicy = replace(mcpPolicyFile, 'mcp.corp.com', publicHostname)
var prmPolicy = replace(loadTextContent('policies/prm.xml'), 'mcp.corp.com', publicHostname)

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

// Named values. Client ids and tenant ids are identifiers, not secrets.
resource nvTenant 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'tenant-id'
  properties: { displayName: 'tenant-id', value: tenantId, secret: false }
}

resource nvMcpClient 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'artifacts-mcp-client-id'
  properties: { displayName: 'artifacts-mcp-client-id', value: artifactsMcpClientId, secret: false }
}

resource nvConnectorClient 'Microsoft.ApiManagement/service/namedValues@2024-05-01' = {
  parent: apim
  name: 'claude-connector-client-id'
  properties: { displayName: 'claude-connector-client-id', value: claudeConnectorClientId, secret: false }
}

// 1. REST API from the frozen contract. Operation names = OpenAPI operationIds.
resource restApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: restApiName
  properties: {
    displayName: 'Artifact intake API'
    description: 'Publish-to-AKS intake. Imported from contracts/intake-openapi.yaml.'
    path: 'artifacts'
    protocols: ['https']
    subscriptionRequired: false
    format: 'openapi'
    value: loadTextContent('../../contracts/intake-openapi.yaml')
    serviceUrl: backendUrl
  }
}

resource opBeginPublish 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'beginPublish'
}

resource opGetStatus 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'getPublishStatus'
}

resource opUpload 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'uploadBundle'
}

resource opFinalize 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'finalizePublish'
}

resource opEvents 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'postPublishEvent'
}

resource opViewToken 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' existing = {
  parent: restApi
  name: 'createViewToken'
}

resource polBeginPublish 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opBeginPublish
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/rest-entra.xml') }
  dependsOn: [restApi, nvTenant, nvMcpClient]
}

resource polGetStatus 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opGetStatus
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/rest-entra.xml') }
  dependsOn: [restApi, nvTenant, nvMcpClient]
}

resource polUpload 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opUpload
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/upload-finalize.xml') }
  dependsOn: [restApi]
}

resource polFinalize 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opFinalize
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/upload-finalize.xml') }
  dependsOn: [restApi]
}

resource polEvents 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opEvents
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/internal-404.xml') }
  dependsOn: [restApi]
}

resource polViewToken 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: opViewToken
  name: 'policy'
  properties: { format: 'rawxml', value: loadTextContent('policies/internal-404.xml') }
  dependsOn: [restApi]
}

// 2. MCP server over beginPublish + getPublishStatus. Endpoint: https://<host>/artifacts-mcp/mcp
// UNVERIFIED: 'mcpTools' is used by Microsoft's AI-Gateway sample (apis@2024-06-01-preview, type 'mcp')
// but is not listed in the ARM schema reference for 2025-09-01-preview, which only documents
// 'mcpProperties' (pass-through to an existing MCP server). Fallback: create-mcp-server.sh.
resource mcpServer 'Microsoft.ApiManagement/service/apis@2025-09-01-preview' = {
  parent: apim
  name: mcpServerName
  properties: {
    displayName: mcpServerName
    description: 'Publish-to-AKS tools: beginPublish, getPublishStatus. Entra OAuth, scope artifacts.publish.'
    type: 'mcp'
    path: mcpServerName
    protocols: ['https']
    subscriptionRequired: false
    #disable-next-line BCP037
    mcpTools: [
      {
        name: 'beginPublish'
        operationId: opBeginPublish.id
        description: 'Start a publish job. Returns a one-time upload URL and token.'
      }
      {
        name: 'getPublishStatus'
        operationId: opGetStatus.id
        description: 'Current state of a publish job, with findings or the live URL.'
      }
    ]
  }
  dependsOn: [restApi]
}

resource mcpPolicyRes 'Microsoft.ApiManagement/service/apis/policies@2025-09-01-preview' = {
  parent: mcpServer
  name: 'policy'
  properties: { format: 'rawxml', value: mcpPolicy }
  dependsOn: [nvTenant, nvMcpClient, nvConnectorClient]
}

// 3. PRM document at the host root: /.well-known/oauth-protected-resource/artifacts-mcp/mcp
resource prmApi 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: apim
  name: 'artifacts-prm'
  properties: {
    displayName: 'OAuth protected resource metadata'
    path: '.well-known/oauth-protected-resource'
    protocols: ['https']
    subscriptionRequired: false
    serviceUrl: 'https://localhost' // never called; return-response short-circuits
  }
}

resource prmOp 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: prmApi
  name: 'artifacts-mcp-prm'
  properties: {
    displayName: 'PRM for artifacts-mcp'
    method: 'GET'
    urlTemplate: '/${mcpServerName}/mcp'
    responses: [{ statusCode: 200, description: 'Protected resource metadata JSON' }]
  }
}

resource prmPolicyRes 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: prmOp
  name: 'policy'
  properties: { format: 'rawxml', value: prmPolicy }
  dependsOn: [nvTenant]
}

output mcpServerUrl string = 'https://${publicHostname}/${mcpServerName}/mcp'
output prmUrl string = 'https://${publicHostname}/.well-known/oauth-protected-resource/${mcpServerName}/mcp'
output restApiId string = restApi.id
