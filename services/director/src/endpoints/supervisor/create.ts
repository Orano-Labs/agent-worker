import { generateKeyPair } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { EndpointHelpers } from "@/endpoints/helpers";

export namespace SupervisorCreate {
  export const Input = z.object({
    body: z.object({
      name: z.string().nonempty().max(128).describe("The display name for the supervisor agent. Must be between 1 and 128 characters."),
    }),
  });

  export const Output = z.object({
    body: z.object({
      uid: z.uuid().describe("The unique identifier (UUID) of the newly created supervisor agent."),
      privateKey: z
        .string()
        .describe(
          "The PEM-encoded Ed25519 private key for the supervisor. This key should be stored securely and used for authentication.",
        ),
    }),
  });

  export const endpoint = EndpointHelpers.external
    .route({
      method: "POST",
      path: "/supervisor",
      description: "Create a new supervisor agent.",
      tags: ["Supervisor"],
    })
    .input(Input)
    .output(Output)
    .handler(async (ctx) => {
      const db = EndpointHelpers.container.database;

      const keys = await new Promise<{ publicKey: Buffer; privateKey: Buffer }>((resolve, reject) => {
        generateKeyPair(
          "ed25519",
          {
            publicKeyEncoding: { type: "spki", format: "der" },
            privateKeyEncoding: { type: "pkcs8", format: "der" },
          },
          (error, publicKey, privateKey) => {
            if (error) {
              return reject(error);
            }

            return resolve({ publicKey, privateKey });
          },
        );
      });

      const [result] = await db.client.insert(db.schema.SUPERVISORS_TABLE).values({
        name: ctx.input.body.name,
        publicKey: keys.publicKey.toString("hex"),
      });

      const [row] = await db.client
        .select({ uid: db.schema.SUPERVISORS_TABLE.uid })
        .from(db.schema.SUPERVISORS_TABLE)
        .where(eq(db.schema.SUPERVISORS_TABLE.id, result.insertId));

      return {
        body: {
          uid: db.uuidFromBuffer(row.uid),
          privateKey: keys.privateKey.toString("hex"),
        },
      };
    });
}
