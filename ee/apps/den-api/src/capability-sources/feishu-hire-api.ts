const DEFAULT_FEISHU_API_BASE_URL = "https://open.feishu.cn"
const REQUEST_TIMEOUT_MS = 30_000

export type FeishuHireCredentials = {
  appId: string
  appSecret: string
  serviceUrl: string
}

export type FeishuHireClientOptions = {
  apiBaseUrl?: string
  fetch?: typeof fetch
}

export type FeishuHireListInput = {
  pageSize?: number
  pageToken?: string
}

export type FeishuHireApplicationsInput = FeishuHireListInput & {
  processId?: string
  stageId?: string
  talentId?: string
  jobId?: string
  activeStatus?: "1" | "2" | "3"
  updateStartTime?: string
  updateEndTime?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function boundedPageSize(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return Math.min(10, maximum)
  return Math.max(1, Math.min(maximum, Math.trunc(value)))
}

function addOptionalQuery(url: URL, name: string, value: string | undefined): void {
  if (value?.trim()) url.searchParams.set(name, value.trim())
}

function ensureFeishuPayload(payload: unknown, label: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error(`${label} returned an invalid response.`)
  const code = numberValue(payload.code)
  // Upstream error text is intentionally not relayed: it is not a trusted
  // boundary and can echo request fields such as app credentials.
  if (code !== null && code !== 0) throw new Error(`${label} failed with code ${code}.`)
  return payload
}

function cityName(value: unknown): string | null {
  const record = recordValue(value)
  return stringValue(record?.zh_name) ?? stringValue(record?.en_name)
}

function sanitizeEducation(value: unknown) {
  return recordList(value).slice(0, 5).map((entry) => ({
    school: stringValue(entry.school) ?? stringValue(entry.school_name),
    degree: numberValue(entry.degree),
    fieldOfStudy: stringValue(entry.field_of_study) ?? stringValue(entry.major),
    startTime: stringValue(entry.start_time),
    endTime: stringValue(entry.end_time_v2) ?? stringValue(entry.end_time),
  }))
}

function sanitizeCareer(value: unknown) {
  return recordList(value).slice(0, 5).map((entry) => ({
    company: stringValue(entry.company) ?? stringValue(entry.company_name),
    title: stringValue(entry.title),
    startTime: stringValue(entry.start_time),
    endTime: stringValue(entry.end_time),
  }))
}

function sanitizeTalentSummary(value: unknown) {
  const talent = recordValue(value) ?? {}
  const basicInfo = recordValue(talent.basic_info) ?? {}
  return {
    id: stringValue(talent.id) ?? stringValue(talent.talent_id),
    name: stringValue(basicInfo.name),
    experienceYears: numberValue(basicInfo.experience_years),
    currentCity: cityName(basicInfo.current_city) ?? stringValue(basicInfo.current_location_code),
    isOnboarded: typeof talent.is_onboarded === "boolean" ? talent.is_onboarded : null,
    topDegree: numberValue(talent.top_degree),
    education: sanitizeEducation(talent.education_list),
    career: sanitizeCareer(talent.career_list),
  }
}

function sanitizeJob(value: unknown) {
  const job = recordValue(value) ?? {}
  const department = recordValue(job.department)
  const recruitmentType = recordValue(job.recruitment_type)
  return {
    id: stringValue(job.id),
    title: stringValue(job.title),
    code: stringValue(job.code),
    description: stringValue(job.description),
    requirement: stringValue(job.requirement),
    department: stringValue(department?.zh_name) ?? stringValue(department?.en_name),
    recruitmentType: stringValue(recruitmentType?.zh_name) ?? stringValue(recruitmentType?.en_name),
    city: cityName(job.city),
    headCount: numberValue(job.head_count),
    processName: stringValue(job.process_name) ?? stringValue(job.process_en_name),
    updatedAt: stringValue(job.update_timestamp),
  }
}

export class FeishuHireClient {
  private readonly credentials: FeishuHireCredentials
  private readonly apiBaseUrl: string
  private readonly fetcher: typeof fetch
  private accessToken: { value: string; expiresAt: number } | null = null
  private accessTokenRequest: Promise<string> | null = null

  constructor(credentials: FeishuHireCredentials, options: FeishuHireClientOptions = {}) {
    this.credentials = credentials
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_FEISHU_API_BASE_URL).replace(/\/$/, "")
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`Feishu Hire request failed with HTTP ${response.status}.`)
    }
    return ensureFeishuPayload(payload, "Feishu Hire")
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value
    if (this.accessTokenRequest) return this.accessTokenRequest
    const request = this.fetchJson(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
    }).then((payload) => {
      const token = stringValue(payload.tenant_access_token)
      if (!token) throw new Error("Feishu Hire authentication returned no tenant access token.")
      const expiresIn = numberValue(payload.expire) ?? 7200
      this.accessToken = { value: token, expiresAt: Date.now() + expiresIn * 1_000 }
      return token
    })
    this.accessTokenRequest = request
    try {
      return await request
    } finally {
      if (this.accessTokenRequest === request) this.accessTokenRequest = null
    }
  }

  private async get(path: string, configure?: (url: URL) => void): Promise<Record<string, unknown>> {
    const url = new URL(path, this.apiBaseUrl)
    configure?.(url)
    return this.fetchJson(url.toString(), {
      headers: { authorization: `Bearer ${await this.token()}` },
    })
  }

  async listJobs(input: FeishuHireListInput = {}) {
    const payload = await this.get("/open-apis/hire/v1/jobs", (url) => {
      url.searchParams.set("page_size", String(boundedPageSize(input.pageSize, 20)))
      addOptionalQuery(url, "page_token", input.pageToken)
    })
    const data = recordValue(payload.data) ?? {}
    return {
      jobs: recordList(data.items).map(sanitizeJob),
      hasMore: data.has_more === true,
      pageToken: stringValue(data.page_token),
    }
  }

  async searchTalents(input: FeishuHireListInput & { keyword?: string } = {}) {
    const payload = await this.get("/open-apis/hire/v1/talents", (url) => {
      url.searchParams.set("page_size", String(boundedPageSize(input.pageSize, 20)))
      url.searchParams.set("query_option", "ignore_empty_error")
      addOptionalQuery(url, "keyword", input.keyword)
      addOptionalQuery(url, "page_token", input.pageToken)
    })
    const data = recordValue(payload.data) ?? {}
    return {
      talents: recordList(data.items).map(sanitizeTalentSummary),
      hasMore: data.has_more === true,
      pageToken: stringValue(data.page_token),
      privacy: "Contact details, identity numbers, addresses, birth dates, gender, and marital status are intentionally omitted.",
    }
  }

  private async talent(talentId: string) {
    const payload = await this.get(`/open-apis/hire/v2/talents/${encodeURIComponent(talentId)}`)
    const data = recordValue(payload.data) ?? {}
    return sanitizeTalentSummary(data.talent ?? data)
  }

  private candidateUrl(talentId: string, applicationId: string): string {
    const tenant = new URL(this.credentials.serviceUrl)
    const url = new URL(`/talent/${encodeURIComponent(talentId)}`, tenant.origin)
    url.searchParams.set("application_id", applicationId)
    return url.toString()
  }

  async listApplications(input: FeishuHireApplicationsInput = {}) {
    const pageSize = boundedPageSize(input.pageSize, 20)
    const payload = await this.get("/open-apis/hire/v1/applications", (url) => {
      url.searchParams.set("page_size", String(pageSize))
      addOptionalQuery(url, "page_token", input.pageToken)
      addOptionalQuery(url, "process_id", input.processId)
      addOptionalQuery(url, "stage_id", input.stageId)
      addOptionalQuery(url, "talent_id", input.talentId)
      addOptionalQuery(url, "job_id", input.jobId)
      addOptionalQuery(url, "active_status", input.activeStatus)
      addOptionalQuery(url, "update_start_time", input.updateStartTime)
      addOptionalQuery(url, "update_end_time", input.updateEndTime)
    })
    const data = recordValue(payload.data) ?? {}
    const applicationIds = Array.isArray(data.items)
      ? data.items.flatMap((item) => {
          const applicationId = stringValue(item)
          return applicationId ? [applicationId] : []
        }).slice(0, pageSize)
      : []
    const talentRequests = new Map<string, Promise<ReturnType<typeof sanitizeTalentSummary>>>()
    const applications = await Promise.all(applicationIds.map(async (applicationId) => {
      const detailPayload = await this.get(`/open-apis/hire/v1/applications/${encodeURIComponent(applicationId)}`)
      const application = recordValue(recordValue(detailPayload.data)?.application) ?? {}
      const talentId = stringValue(application.talent_id)
      const stage = recordValue(application.stage)
      let candidate: ReturnType<typeof sanitizeTalentSummary> | null = null
      if (talentId) {
        const existing = talentRequests.get(talentId)
        const request = existing ?? this.talent(talentId)
        if (!existing) talentRequests.set(talentId, request)
        candidate = await request
      }
      return {
        id: applicationId,
        jobId: stringValue(application.job_id),
        talentId,
        candidate,
        stage: {
          id: stringValue(stage?.id),
          name: stringValue(stage?.zh_name) ?? stringValue(stage?.en_name),
          type: numberValue(stage?.type),
        },
        active: application.active_status === 1,
        createdAt: stringValue(application.create_time),
        updatedAt: stringValue(application.modify_time),
        candidateUrl: talentId ? this.candidateUrl(talentId, applicationId) : null,
      }
    }))
    return {
      applications,
      hasMore: data.has_more === true,
      pageToken: stringValue(data.page_token),
      privacy: "Only recruiting-relevant summaries are returned; direct contact and identity fields are omitted.",
    }
  }
}
