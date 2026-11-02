"use client";

import { Dialog } from "@base-ui/react/dialog";
import { buttonVariants } from "../../_components/ui/button";

export const AUTO_ROUTER_SETUP_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/auto-model-routing#self-hosted";

/**
 * Shown when an admin tries to create or edit a Smart Router while the AI Gateway has
 * no TypeSafe (Jev) key. Only the person who runs the OpenWork instance can add
 * it, so the dialog names who acts and the exact steps (DESIGN.md P2, P4).
 */
export function AutoRouterSetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <Dialog.Popup
          data-testid="auto-router-setup-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none"
        >
          <Dialog.Title className="text-[15px] font-medium leading-5 text-gray-950">
            Smart Model Router needs a routing key
          </Dialog.Title>
          <div className="mt-2 flex flex-col gap-3 text-[13px] leading-5 text-gray-600">
            <Dialog.Description>
              Smart Model Router uses Jev, a routing model from TypeSafe, to choose a model for each prompt. Your AI Gateway
              doesn&apos;t have its key yet. Ask the person who runs your OpenWork instance to:
            </Dialog.Description>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Get a TypeSafe API key.</li>
              <li>
                Add it to the AI Gateway as <code className="rounded bg-gray-100 px-1 text-[12px] text-gray-800">TYPESAFE_API_KEY</code>.
                With the Helm chart, set <code className="rounded bg-gray-100 px-1 text-[12px] text-gray-800">secret.values.typesafeApiKey</code>.
              </li>
              <li>Restart the AI Gateway, then come back here to create Smart Routers.</li>
            </ol>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <a
              href={AUTO_ROUTER_SETUP_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="auto-router-setup-docs"
              className={buttonVariants({ variant: "secondary" })}
            >
              Setup guide
            </a>
            <Dialog.Close data-testid="auto-router-setup-close" className={buttonVariants({ variant: "primary" })}>
              Got it
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
