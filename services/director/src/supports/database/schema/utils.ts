import { customType } from "drizzle-orm/mysql-core";

// Custom binary type to handle Buffer data correctly.
// Drizzle ORM has issues with binary types - it calls Buffer.toString() which converts binary data to string.
// This custom type returns the raw Buffer without conversion.
export const binary = customType<{
  data: Buffer;
  driverData: Buffer;
  config: {
    length?: number;
  };
  configRequired: false;
}>({
  dataType(config) {
    return config?.length === undefined ? `binary` : `binary(${config.length})`;
  },
});
