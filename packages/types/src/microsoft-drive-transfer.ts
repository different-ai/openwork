/** Pulls and desktop saves both stream through OpenWork Cloud, so both share Google pulls' cap. */
export const MICROSOFT_DRIVE_TRANSFER_MAX_BYTES = 250 * 1024 * 1024
export const MICROSOFT_DRIVE_PULL_CHUNK_BYTES = 8 * 1024 * 1024
/** Graph upload fragments must be multiples of 320 KiB; 32 of them is 10 MiB. */
export const MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES = 32 * 320 * 1024
/** Graph's own limit, for clients that upload straight to Microsoft. */
export const MICROSOFT_DRIVE_UPLOAD_MAX_BYTES = 250 * 1000 ** 3
