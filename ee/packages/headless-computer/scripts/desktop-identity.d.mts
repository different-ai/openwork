export declare const IMAGE_FILES: string[]
export declare const GUEST_OPTIONAL_PACKAGES: string[]
export declare function imageIdentity(input: { root: string }): Promise<string>
export declare function guestIdentity(input: { root: string; workingDirectory: string; inputs: string[] }): Promise<string>
