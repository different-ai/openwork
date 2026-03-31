import { customType, timestamp, varchar } from "drizzle-orm/mysql-core";
import {
    type DenTypeId,
    type DenTypeIdName,
    normalizeDenTypeId,
} from "@openwork-ee/utils/typeid";
import { sql } from "drizzle-orm";

const INTERNAL_ID_LENGTH = 64;
const AUTH_EXTERNAL_ID_LENGTH = 36;

export const authExternalIdColumn = (columnName: string) =>
    varchar(columnName, { length: AUTH_EXTERNAL_ID_LENGTH });

export const denTypeIdColumn = <TName extends DenTypeIdName>(
    name: TName,
    columnName: string,
) =>
    customType<{ data: DenTypeId<TName>; driverData: string }>({
        dataType() {
            return `varchar(${INTERNAL_ID_LENGTH})`;
        },
        toDriver(value) {
            return normalizeDenTypeId(name, value);
        },
        fromDriver(value) {
            return normalizeDenTypeId(name, value);
        },
    })(columnName);

export const timestamps = {
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { fsp: 3 })
        .notNull()
        .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
};
