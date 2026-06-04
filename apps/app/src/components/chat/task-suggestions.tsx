"use client"

import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { useMessageList } from "@/components/chat/message-list-provider"
import { cn } from "@/lib/utils"
import { BoltIcon, CubeIcon, DocumentChartBarIcon, GlobeAltIcon } from "@heroicons/react/24/solid"

const CSV_PROMPT =
  "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data."

const BROWSER_PROMPT =
  "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices."

interface TaskSuggestionsProps {
  className?: string
}

export function TaskSuggestions({ className }: TaskSuggestionsProps) {
  const { displaySuggestions, providerConnectedCount, dispatchAction, setPrompt } = useMessageList()

  if (!displaySuggestions) {
    return null
  }

  const noProviders = providerConnectedCount === 0

  return (
    <div className={cn("@container flex flex-col gap-4 pt-1", className)}>
      <p className="text-muted-foreground font-medium select-none">
        {noProviders ? "Connect a model provider to get started:" : "Try one of these:"}
      </p>
      <div className="grid min-w-0 gap-2 @lg:grid-cols-2 @2xl:grid-cols-3">
        {noProviders ? (
          <DescriptiveButton
            orientation="vertical"
            className="border-blue-7/50 bg-blue-2/30 hover:bg-blue-3/40 @lg:col-span-2 @2xl:col-span-3"
            onClick={() =>
              dispatchAction({
                target: "settings",
                action: "open",
                section: "providers",
              })
            }
          >
            <DescriptiveButtonIcon>
              <BoltIcon className="size-6 text-blue-10" aria-hidden />
            </DescriptiveButtonIcon>
            <DescriptiveButtonContent>
              <DescriptiveButtonTitle>Connect a model provider</DescriptiveButtonTitle>
              <DescriptiveButtonDescription>
                Add an API key for Anthropic, OpenAI, Google, or others
              </DescriptiveButtonDescription>
            </DescriptiveButtonContent>
          </DescriptiveButton>
        ) : null}

        <DescriptiveButton orientation="vertical" onClick={() => setPrompt(CSV_PROMPT)}>
          <DescriptiveButtonIcon>
            <DocumentChartBarIcon className="size-6 text-green-10" aria-hidden />
          </DescriptiveButtonIcon>
          <DescriptiveButtonContent>
            <DescriptiveButtonTitle>Edit a CSV</DescriptiveButtonTitle>
            <DescriptiveButtonDescription>Create a sample spreadsheet</DescriptiveButtonDescription>
          </DescriptiveButtonContent>
        </DescriptiveButton>

        <DescriptiveButton orientation="vertical" onClick={() => setPrompt(BROWSER_PROMPT)}>
          <DescriptiveButtonIcon>
            <GlobeAltIcon className="size-6 text-blue-10" aria-hidden />
          </DescriptiveButtonIcon>
          <DescriptiveButtonContent>
            <DescriptiveButtonTitle>Browse the web</DescriptiveButtonTitle>
            <DescriptiveButtonDescription>Search Craigslist for couches</DescriptiveButtonDescription>
          </DescriptiveButtonContent>
        </DescriptiveButton>

        <DescriptiveButton
          orientation="vertical"
          onClick={() =>
            dispatchAction({
              target: "settings",
              action: "open",
              section: "mcps",
            })
          }
        >
          <DescriptiveButtonIcon>
            <CubeIcon className="size-6 text-amber-10" aria-hidden />
          </DescriptiveButtonIcon>
          <DescriptiveButtonContent>
            <DescriptiveButtonTitle>Connect an extension</DescriptiveButtonTitle>
            <DescriptiveButtonDescription>Add MCPs and integrations</DescriptiveButtonDescription>
          </DescriptiveButtonContent>
        </DescriptiveButton>
      </div>
    </div>
  )
}
