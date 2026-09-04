/**
 * Catalog (models.dev) providers reach members' machines and cloud workers
 * under a provider-scoped env name: a short tag derived from the provider's
 * row id, then the catalog's declared name (`LPR_120JV_OPENAI_API_KEY`). The
 * tag only exists once the row does, so an unsaved provider shows a
 * placeholder tag in its place.
 */

const PENDING_TAG = "LPR_\u00b7\u00b7\u00b7\u00b7\u00b7";

export type RuntimeEnvKey = {
    /** The scoping tag, the placeholder while unsaved, or null when the name is used as declared. */
    tag: string | null;
    /** The name as the catalog or author declared it. */
    declared: string;
    /** True until the provider is created and the real tag is known. */
    pending: boolean;
};

/**
 * Pair each declared env name with what the runtime will actually read.
 * `runtimeEnvKeys` comes from Den for a saved provider; a Den that predates it
 * returns none, in which case the declared name is shown as-is rather than a
 * guess.
 */
export function resolveRuntimeEnvKeys(input: {
    declaredEnvNames: string[];
    scoped: boolean;
    saved: boolean;
    runtimeEnvKeys: string[];
}): RuntimeEnvKey[] {
    return input.declaredEnvNames.map((declared, index) => {
        if (!input.scoped) return { tag: null, declared, pending: false };
        if (!input.saved) return { tag: PENDING_TAG, declared, pending: true };
        const runtime = input.runtimeEnvKeys[index];
        const suffix = `_${declared}`;
        if (runtime && runtime !== declared && runtime.endsWith(suffix)) {
            return { tag: runtime.slice(0, -suffix.length), declared, pending: false };
        }
        return { tag: null, declared, pending: false };
    });
}

export function runtimeEnvKeyText(key: RuntimeEnvKey): string {
    return key.tag ? `${key.tag}_${key.declared}` : key.declared;
}

export function RuntimeEnvKeyChip({ envKey, className }: { envKey: RuntimeEnvKey; className: string }) {
    return (
        <span className={className} title={envKey.pending ? "The tag is assigned when the provider is created." : undefined}>
            {envKey.tag ? (
                <span className={envKey.pending ? "text-gray-400" : "text-gray-500"}>{envKey.tag}_</span>
            ) : null}
            {envKey.declared}
        </span>
    );
}

export function RuntimeEnvKeyNote({ keys }: { keys: RuntimeEnvKey[] }) {
    if (keys.length === 0 || keys.every((key) => key.tag === null)) return null;
    return (
        <p className="mt-2 text-[12px] leading-5 text-gray-500">
            {keys.some((key) => key.pending)
                ? "Members' machines read this under a provider-specific name. The 5-character tag is assigned when the provider is created and stays fixed."
                : "The exact name members' machines and cloud workers read for this provider. It never collides with a key someone set themselves or with another provider of the same kind."}
        </p>
    );
}
