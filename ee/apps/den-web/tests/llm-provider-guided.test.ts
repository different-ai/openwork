import { describe, expect, test } from "bun:test";

import {
    buildGuidedCustomProviderConfig,
    buildGuidedProviderEnvName,
    parseGuidedModelIds,
    readGuidedCustomProviderFields,
    readGuidedCustomProviderFieldsFromText,
    slugifyProviderId,
    validateGuidedCustomProvider,
} from "../app/(den)/dashboard/_components/llm-provider-guided";

describe("slugifyProviderId", () => {
    test("derives a config-safe id from a display name", () => {
        expect(slugifyProviderId("Azure AI Foundry")).toBe("azure-ai-foundry");
        expect(slugifyProviderId("  My_Gateway!! ")).toBe("my-gateway");
    });
});

describe("parseGuidedModelIds", () => {
    test("splits on newlines and commas, trims, and dedupes", () => {
        expect(parseGuidedModelIds("gpt-5.2\n my-deployment ,gpt-5.2,,")).toEqual([
            "gpt-5.2",
            "my-deployment",
        ]);
    });
});

describe("buildGuidedProviderEnvName", () => {
    test("builds an uppercase env var name", () => {
        expect(buildGuidedProviderEnvName("azure-foundry")).toBe("AZURE_FOUNDRY_API_KEY");
    });
});

describe("validateGuidedCustomProvider", () => {
    test("accepts a valid input", () => {
        expect(
            validateGuidedCustomProvider({
                providerId: "azure-foundry",
                baseUrl: "https://x.example.com/v1",
                modelIds: ["m1"],
            }),
        ).toBeNull();
    });

    test("rejects missing or malformed fields", () => {
        expect(
            validateGuidedCustomProvider({ providerId: "", baseUrl: "https://x", modelIds: ["m"] }),
        ).toContain("ID");
        expect(
            validateGuidedCustomProvider({ providerId: "bad id", baseUrl: "https://x", modelIds: ["m"] }),
        ).toContain("Provider IDs");
        expect(
            validateGuidedCustomProvider({ providerId: "ok", baseUrl: "ftp://x", modelIds: ["m"] }),
        ).toContain("http");
        expect(
            validateGuidedCustomProvider({ providerId: "ok", baseUrl: "https://x", modelIds: [] }),
        ).toContain("model");
    });
});

describe("buildGuidedCustomProviderConfig", () => {
    test("generates the models.dev-style config the API expects", () => {
        expect(
            buildGuidedCustomProviderConfig({
                providerId: "azure-foundry",
                name: "Azure AI Foundry",
                baseUrl: "https://my-resource.openai.azure.com/openai/v1/",
                modelIds: ["gpt-5.2", "my-deployment"],
            }),
        ).toEqual({
            id: "azure-foundry",
            name: "Azure AI Foundry",
            npm: "@ai-sdk/openai-compatible",
            env: ["AZURE_FOUNDRY_API_KEY"],
            api: "https://my-resource.openai.azure.com/openai/v1",
            models: [
                { id: "gpt-5.2", name: "gpt-5.2" },
                { id: "my-deployment", name: "my-deployment" },
            ],
        });
    });

    test("preserves an existing env name when provided", () => {
        const config = buildGuidedCustomProviderConfig({
            providerId: "renamed",
            name: "Renamed",
            baseUrl: "https://x.example.com/v1",
            modelIds: ["m"],
            envName: "ORIGINAL_API_KEY",
        });
        expect(config.env).toEqual(["ORIGINAL_API_KEY"]);
    });
});

describe("readGuidedCustomProviderFields", () => {
    const simple = {
        id: "azure-foundry",
        name: "Azure AI Foundry",
        npm: "@ai-sdk/openai-compatible",
        env: ["AZURE_FOUNDRY_API_KEY"],
        api: "https://x.example.com/v1",
        models: [{ id: "m1", name: "m1" }],
    };

    test("round-trips a form-generated config", () => {
        const generated = buildGuidedCustomProviderConfig({
            providerId: "azure-foundry",
            name: "Azure AI Foundry",
            baseUrl: "https://x.example.com/v1",
            modelIds: ["m1", "m2"],
        });
        expect(readGuidedCustomProviderFields(generated)).toEqual({
            providerId: "azure-foundry",
            baseUrl: "https://x.example.com/v1",
            modelIds: ["m1", "m2"],
            envName: "AZURE_FOUNDRY_API_KEY",
        });
    });

    test("falls back to JSON for configs the form cannot represent", () => {
        expect(readGuidedCustomProviderFields({ ...simple, npm: "@ai-sdk/azure" })).toBeNull();
        expect(readGuidedCustomProviderFields({ ...simple, options: { baseURL: "x" } })).toBeNull();
        expect(
            readGuidedCustomProviderFields({
                ...simple,
                models: [{ id: "m1", name: "m1", limit: { context: 128000 } }],
            }),
        ).toBeNull();
        expect(
            readGuidedCustomProviderFields({
                ...simple,
                models: [{ id: "m1", name: "Fancy Display Name" }],
            }),
        ).toBeNull();
        expect(readGuidedCustomProviderFields({ ...simple, api: undefined })).toBeNull();
    });
});

describe("readGuidedCustomProviderFieldsFromText", () => {
    test("parses a bare provider block", () => {
        const text = JSON.stringify({
            id: "gateway",
            name: "Gateway",
            npm: "@ai-sdk/openai-compatible",
            env: ["GATEWAY_API_KEY"],
            api: "https://llm.example.com/v1",
            models: [{ id: "deepseek/deepseek-v3.2", name: "deepseek/deepseek-v3.2" }],
        });
        expect(readGuidedCustomProviderFieldsFromText(text)?.providerId).toBe("gateway");
    });

    test("parses an opencode-style wrapper", () => {
        const text = JSON.stringify({
            provider: {
                gateway: {
                    name: "Gateway",
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://llm.example.com/v1",
                    models: ["m1"],
                },
            },
        });
        expect(readGuidedCustomProviderFieldsFromText(text)).toEqual({
            providerId: "gateway",
            baseUrl: "https://llm.example.com/v1",
            modelIds: ["m1"],
            envName: null,
        });
    });

    test("returns null for invalid JSON", () => {
        expect(readGuidedCustomProviderFieldsFromText("{ nope")).toBeNull();
    });
});
