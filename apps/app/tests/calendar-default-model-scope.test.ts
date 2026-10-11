import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { calendarDefaultModelQueryKey, visibleCalendarDefaultModelName } from "../src/react-app/domains/calendar/calendar-default-model-scope"

const ownerKey = calendarDefaultModelQueryKey("https://den.example.test", "org-one", "owner")
const privateName = "Owner-only planning model"

test("another member of the same organization cannot reuse the owner's settings", () => {
  const cache = new QueryClient()
  cache.setQueryData(ownerKey, privateName)
  expect(cache.getQueryData(ownerKey)).toBe(privateName)
  const memberKey = calendarDefaultModelQueryKey("https://den.example.test", "org-one", "member")
  expect(cache.getQueryData(memberKey)).toBeUndefined()
  expect(cache.getQueryData(calendarDefaultModelQueryKey("https://den.example.test", "org-one", null))).toBeUndefined()
  cache.clear()
})

test("a different Den server cannot reuse a similarly named principal and organization", () => {
  const cache = new QueryClient()
  cache.setQueryData(ownerKey, privateName)
  expect(cache.getQueryData(calendarDefaultModelQueryKey("https://other-den.example.test", "org-one", "owner"))).toBeUndefined()
  cache.clear()
})

test("denied revalidation hides the old permitted model name, even when TanStack retains its data", async () => {
  const cache = new QueryClient()
  cache.setQueryData(ownerKey, privateName)
  await expect(cache.fetchQuery({ queryKey: ownerKey, retry: false, staleTime: 0, queryFn: async () => { throw new Error("permission denied") } })).rejects.toThrow("permission denied")
  const oldName = cache.getQueryData<string>(ownerKey)
  expect(oldName).toBe(privateName)
  expect(cache.getQueryState(ownerKey)?.status).toBe("error")
  expect(visibleCalendarDefaultModelName({ verified: true, fetching: false, failed: true, name: oldName })).toBeUndefined()
  cache.clear()
})

test("only a verified, successful response is visible", () => {
  expect(visibleCalendarDefaultModelName({ verified: true, fetching: false, failed: false, name: privateName })).toBe(privateName)
  expect(visibleCalendarDefaultModelName({ verified: false, fetching: false, failed: false, name: privateName })).toBeUndefined()
  expect(visibleCalendarDefaultModelName({ verified: true, fetching: true, failed: false, name: privateName })).toBeUndefined()
})
