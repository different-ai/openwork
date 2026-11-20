"use client"

import { Tool } from "@/components/ui/tool"
import type { QuestionToolPart } from "@/lib/build-in-tools"
import { toolDisplayTitle, truncateText } from "@/components/tools/path"

interface QuestionToolProps {
  part: QuestionToolPart
}

function getFirstQuestionLabel(part: QuestionToolPart) {
  const first = part.input?.questions?.[0]
  if (!first) {
    return undefined
  }

  const header = first.header?.trim() ?? ""
  const question = first.question?.trim() ?? ""
  const label = header || question
  return label ? truncateText(label, 56) : undefined
}

function getQuestionToolTitle(part: QuestionToolPart): string | null {
  const label = getFirstQuestionLabel(part)
  const count = part.input?.questions?.length ?? 0

  if (part.state === "output-error") {
    return label ?? "Asked a question"
  }

  if (part.state !== "output-available") {
    return null
  }

  if (label) {
    return label
  }

  return count > 1 ? `Asked ${count} questions` : "Asked a question"
}

function getQuestionToolDetail(part: QuestionToolPart): string | undefined {
  const count = part.input?.questions?.length ?? 0

  if (part.state === "output-available") {
    return "Answered"
  }

  if (count > 1) {
    return `${count} questions`
  }

  return undefined
}

const ANSWERED_OUTPUT = /^User has answered your questions?: "[\s\S]*"="([\s\S]*)"\. You can now continue/

export function questionToolAnswers(part: QuestionToolPart): string[][] | null {
  if (part.state !== "output-available") return null
  const fromMetadata = part.callProviderMetadata?.openwork?.questionAnswers
  if (Array.isArray(fromMetadata) && fromMetadata.every((answer) => Array.isArray(answer) && answer.every((value) => typeof value === "string"))) {
    return fromMetadata as string[][]
  }
  if ((part.input?.questions?.length ?? 0) !== 1 || typeof part.output !== "string") return null
  const answer = ANSWERED_OUTPUT.exec(part.output)?.[1]?.trim()
  return answer && answer !== "Unanswered" ? [[answer]] : null
}

export function questionAnswerSummary(answers: string[][] | null): string | null {
  const parts = (answers ?? []).map((answer) => answer.map((value) => value.trim()).filter(Boolean).join(", ")).filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : null
}

export function QuestionTool({ part }: QuestionToolProps) {
  const answers = questionToolAnswers(part)
  const summary = questionAnswerSummary(answers)
  const questions = part.input?.questions ?? []

  if (!summary || !answers) {
    return (
      <Tool
        toolPart={part}
        title={toolDisplayTitle(
          getQuestionToolTitle(part),
          getQuestionToolDetail(part)
        )}
      />
    )
  }

  return (
    <Tool toolPart={part} title="You answered" detail={summary}>
      <dl className="flex flex-col gap-2" data-testid="question-tool-answers">
        {questions.map((question, index) => (
          <div key={`${index}:${question.question}`} className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground whitespace-pre-wrap wrap-break-word">{question.question || question.header}</dt>
            <dd className="text-foreground whitespace-pre-wrap wrap-break-word">
              {answers[index]?.filter((value) => value.trim()).join(", ") || "No answer"}
            </dd>
          </div>
        ))}
      </dl>
    </Tool>
  )
}
