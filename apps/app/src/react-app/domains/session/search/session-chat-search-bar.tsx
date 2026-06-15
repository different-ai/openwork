/** @jsxImportSource react */
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

export type SessionChatSearchBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  statusLabel: string;
  canNavigate: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
};

export function SessionChatSearchBar(props: SessionChatSearchBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 mac:backdrop-blur-xl">
      <InputGroup className="h-8 flex-1">
        <InputGroupAddon align="inline-start" className="ps-2.5">
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          ref={props.inputRef}
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder="Search this chat…"
          aria-label="Search this chat"
          autoComplete="off"
          spellCheck={false}
        />
        <InputGroupAddon align="inline-end" className="pe-1.5">
          {props.statusLabel ? (
            <span className="px-1 text-xs tabular-nums text-muted-foreground">
              {props.statusLabel}
            </span>
          ) : null}
          <InputGroupButton
            size="icon-xs"
            onClick={props.onPrev}
            disabled={!props.canNavigate}
            aria-label="Previous match"
            title="Previous match"
          >
            <ChevronUpIcon />
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            onClick={props.onNext}
            disabled={!props.canNavigate}
            aria-label="Next match"
            title="Next match"
          >
            <ChevronDownIcon />
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            onClick={props.onClose}
            aria-label="Close search"
            title="Close"
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
