"use client";

import { useExampleStep } from "../use-example-step";
import { ExampleCaption } from "../example-parts";
import { promptCardsExampleCards } from "./prompt-cards-example-data";

/** Desktop tab example: the suggestion cards someone sees when they start a new session. */
export function PromptCardsExample() {
  const step = useExampleStep(promptCardsExampleCards.length);

  return (
    <div>
      <ExampleCaption>A new session in the desktop app</ExampleCaption>
      <div className="flex flex-col gap-2">
        {promptCardsExampleCards.map((card, index) => (
          <div
            key={card.title}
            className={`flex flex-col rounded-xl border px-3 py-2 transition-colors duration-200 ease-out ${step === index ? "border-gray-300 bg-gray-50" : "border-gray-200"}`}
          >
            <span className="truncate text-[13px] font-medium text-gray-900">{card.title}</span>
            <span className="truncate text-[12px] text-gray-500">{card.prompt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
