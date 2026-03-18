import { customType, varchar } from "drizzle-orm/mysql-core"
import {
  type DenTypeId,
  type DenTypeIdName,
  normalizeDenTypeId,
} from "@different-ai/openwork-utils/typeid"

const INTERNAL_ID_LENGTH = 64
const AUTH_EXTERNAL_ID_LENGTH = 36

export const authExternalIdColumn = (columnName: string) =>
  varchar(columnName, { length: AUTH_EXTERNAL_ID_LENGTH })

export const denTypeIdColumn = <TName extends DenTypeIdName>(
  name: TName,
  columnName: string,
) =>
  customType<{ data: DenTypeId<TName>; driverData: string }>({
    dataType() {
      return `varchar(${INTERNAL_ID_LENGTH})`
    },
    toDriver(value) {
      return normalizeDenTypeId(name, value)
    },
    fromDriver(value) {
      return normalizeDenTypeId(name, value)
    },
  })(columnName)
