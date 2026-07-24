import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInFallbackNotice } from "../src/react-app/domains/cloud/signin-fallback-notice";

test("sign-in fallback shows the complete URL as a clickable link", () => {
  const url = "https://example.com/sign-in?state=visible";
  const html = renderToStaticMarkup(<SignInFallbackNotice url={url} />);

  expect(html).toContain(`href="${url}"`);
  expect(html).toContain(url);
  expect(html).toContain("Copy sign-in link");
});
