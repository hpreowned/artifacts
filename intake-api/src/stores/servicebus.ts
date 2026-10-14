import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import type { ScanMessage, ScanQueue } from "./types.js";

function isScanMessage(body: unknown): body is ScanMessage {
  return typeof body === "object" && body !== null && typeof (body as ScanMessage).jobId === "string";
}

/** One queue, peek-lock, one message at a time. A thrown handler abandons the message for redelivery. */
export class ServiceBusScanQueue implements ScanQueue {
  private readonly client: ServiceBusClient;

  constructor(fqdn: string, private readonly queue: string) {
    this.client = new ServiceBusClient(fqdn, new DefaultAzureCredential());
  }

  async enqueue(message: ScanMessage): Promise<void> {
    const sender = this.client.createSender(this.queue);
    try {
      await sender.sendMessages({ body: message, contentType: "application/json" });
    } finally {
      await sender.close();
    }
  }

  subscribe(handler: (message: ScanMessage) => Promise<void>): () => Promise<void> {
    const receiver = this.client.createReceiver(this.queue, { receiveMode: "peekLock" });
    const subscription = receiver.subscribe(
      {
        processMessage: async (message) => {
          if (!isScanMessage(message.body)) {
            console.error("[queue] dropping message without jobId", message.messageId);
            return;
          }
          await handler(message.body);
        },
        processError: async (args) => {
          console.error("[queue] receiver error", args.errorSource, args.error);
        },
      },
      { maxConcurrentCalls: 1, autoCompleteMessages: true },
    );
    return async () => {
      await subscription.close();
      await receiver.close();
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
