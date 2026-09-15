/*
 * Selected rules from Gitleaks config/gitleaks.toml, pinned at
 * b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b:
 * https://github.com/gitleaks/gitleaks/blob/b58d3f102cf3a2c84cb7f923d05c25c9b1aed84b/config/gitleaks.toml
 * Regexes, keywords and entropy thresholds are copied verbatim; leading Go
 * (?i) becomes the JS i flag. Scoped (?-i:...) and \x60 remain unchanged.
 * g/d enable iteration and exact capture offsets, not additional detection.
 * All selected rules use capture 1 when present, otherwise the whole match.
 * Allowlists, stopwords, path rules and decoding are not ported. In particular,
 * generic-api-key is a heuristic, not a promise to detect arbitrary secrets.
 *
 * MIT License
 * Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type SecretPattern = {
  id: string;
  regex: RegExp;
  keywords: readonly string[];
  entropy?: number;
  precision: "high" | "heuristic";
};

export const secretPatterns: readonly SecretPattern[] = [
  // private-key
  {
    id: "private-key",
    regex: new RegExp(String.raw`-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----`, "gdi"),
    keywords: ["-----begin"],
    precision: "high",
  },
  // aws-access-token
  {
    id: "aws-access-token",
    regex: new RegExp(String.raw`\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b`, "gd"),
    keywords: ["a3t", "akia", "asia", "abia", "acca"],
    entropy: 3,
    precision: "high",
  },
  // github-pat
  {
    id: "github-pat",
    regex: new RegExp(String.raw`ghp_[0-9a-zA-Z]{36}`, "gd"),
    keywords: ["ghp_"],
    entropy: 3,
    precision: "high",
  },
  // github-oauth
  {
    id: "github-oauth",
    regex: new RegExp(String.raw`gho_[0-9a-zA-Z]{36}`, "gd"),
    keywords: ["gho_"],
    entropy: 3,
    precision: "high",
  },
  // github-app-token
  {
    id: "github-app-token",
    regex: new RegExp(String.raw`(?:ghu|ghs)_[0-9a-zA-Z]{36}`, "gd"),
    keywords: ["ghu_", "ghs_"],
    entropy: 3,
    precision: "high",
  },
  // github-fine-grained-pat
  {
    id: "github-fine-grained-pat",
    regex: new RegExp(String.raw`github_pat_\w{82}`, "gd"),
    keywords: ["github_pat_"],
    entropy: 3,
    precision: "high",
  },
  // slack-bot-token
  {
    id: "slack-bot-token",
    regex: new RegExp(String.raw`xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*`, "gd"),
    keywords: ["xoxb"],
    entropy: 3,
    precision: "high",
  },
  // slack-user-token
  {
    id: "slack-user-token",
    regex: new RegExp(String.raw`xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}`, "gd"),
    keywords: ["xoxp-", "xoxe-"],
    entropy: 2,
    precision: "high",
  },
  // slack-webhook-url
  {
    id: "slack-webhook-url",
    regex: new RegExp(String.raw`(?:https?://)?hooks.slack.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}`, "gd"),
    keywords: ["hooks.slack.com"],
    precision: "high",
  },
  // stripe-access-token
  {
    id: "stripe-access-token",
    regex: new RegExp(String.raw`\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\x60'"\s;]|\\[nr]|$)`, "gd"),
    keywords: ["sk_test", "sk_live", "sk_prod", "rk_test", "rk_live", "rk_prod"],
    entropy: 2,
    precision: "high",
  },
  // openai-api-key
  {
    id: "openai-api-key",
    regex: new RegExp(String.raw`\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)`, "gd"),
    keywords: ["t3blbkfj"],
    entropy: 3,
    precision: "high",
  },
  // anthropic-api-key
  {
    id: "anthropic-api-key",
    regex: new RegExp(String.raw`\b(sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)`, "gd"),
    keywords: ["sk-ant-api03"],
    precision: "high",
  },
  // gcp-api-key
  {
    id: "gcp-api-key",
    regex: new RegExp(String.raw`\b(AIza[\w-]{35})(?:[\x60'"\s;]|\\[nr]|$)`, "gd"),
    keywords: ["aiza"],
    entropy: 4,
    precision: "high",
  },
  // npm-access-token
  {
    id: "npm-access-token",
    regex: new RegExp(String.raw`\b(npm_[a-z0-9]{36})(?:[\x60'"\s;]|\\[nr]|$)`, "gdi"),
    keywords: ["npm_"],
    entropy: 2,
    precision: "high",
  },
  // gitlab-pat
  {
    id: "gitlab-pat",
    regex: new RegExp(String.raw`glpat-[\w-]{20}`, "gd"),
    keywords: ["glpat-"],
    entropy: 3,
    precision: "high",
  },
  // jwt
  {
    id: "jwt",
    regex: new RegExp(String.raw`\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.(?:[a-zA-Z0-9\/\\_-]{10,}={0,2})?)(?:[\x60'"\s;]|\\[nr]|$)`, "gd"),
    keywords: ["ey"],
    entropy: 3,
    precision: "high",
  },
  // generic-api-key
  {
    id: "generic-api-key",
    regex: new RegExp(String.raw`[\w.-]{0,50}?(?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|passw(?:or)?d|secret|token)(?:[ \t\w.-]{0,20})[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([\w.=-]{10,150}|[a-z0-9][a-z0-9+/]{11,}={0,3})(?:[\x60'"\s;]|\\[nr]|$)`, "gdi"),
    keywords: ["access", "api", "auth", "key", "credential", "creds", "passwd", "password", "secret", "token"],
    entropy: 3.5,
    precision: "heuristic",
  },
];

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function redactSecretPatterns(text: string): string {
  const lower = text.toLowerCase();
  const spans: { start: number; end: number; id: string }[] = [];
  for (const rule of secretPatterns) {
    if (!rule.keywords.some((keyword) => lower.includes(keyword))) continue;
    for (const match of text.matchAll(rule.regex)) {
      const span = match.indices?.[match.length > 1 ? 1 : 0];
      if (!span) continue;
      const [start, end] = span;
      if (rule.entropy !== undefined && shannonEntropy(text.slice(start, end)) <= rule.entropy) continue;
      if (spans.some((prior) => start < prior.end && end > prior.start)) continue;
      spans.push({ start, end, id: rule.id });
    }
    if (rule.id === "private-key") {
      // Verbatim upstream header prefix. An unmatched block fails closed to EOF;
      // the upstream full-block rule alone requires a terminator and 64+ characters.
      const header = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi;
      for (const match of text.matchAll(header)) {
        if (!spans.some((span) => match.index >= span.start && match.index < span.end)) {
          spans.push({ start: match.index, end: text.length, id: rule.id });
        }
      }
    }
  }
  // Resolve against the original text so generic matches never consume typed markers.
  spans.sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start) + `[redacted:${span.id}]`;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
