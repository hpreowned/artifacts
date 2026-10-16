// The two tools APIM exposes in production (contracts/intake-openapi.yaml, operations marked x-mcp-tool),
// backed here by the local intake API so Claude Code can exercise the real skill end to end with no Azure.
import { IntakeClient } from "../../cli/src/client.js";
import type { Tool } from "./protocol.js";

export function tools(client: IntakeClient): Tool[] {
  return [
    {
      name: "beginPublish",
      description:
        "Start a publish job for a finished artifact. Takes the manifest object (contracts/manifest.schema.json). " +
        "Returns jobId, uploadUrl, uploadToken, uploadExpiresAt and maxBytes. The bundle itself is uploaded by " +
        "the skill's upload.sh script, never through this tool.",
      inputSchema: {
        type: "object",
        properties: { manifest: { type: "object", description: "The artifact manifest, schemaVersion 2." } },
        required: ["manifest"],
        additionalProperties: false,
      },
      handler: async (args) => client.beginPublish(args.manifest),
    },
    {
      name: "getPublishStatus",
      description:
        "Current state of a publish job: state, findings, url, expiresAt, approval and summary. Poll until the " +
        "state is rejected, awaiting_approval, live, failed or expired.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", description: "The jobId returned by beginPublish." } },
        required: ["jobId"],
        additionalProperties: false,
      },
      handler: async (args) => client.status(String(args.jobId)),
    },
  ];
}
