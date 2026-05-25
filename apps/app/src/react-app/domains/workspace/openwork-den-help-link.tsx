/** @jsxImportSource react */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SUPPORT_EMAIL = "team@openworklabs.com";
const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=OpenWork%20Den%20remote%20worker%20upgrade`;

/**
 * Small inline link rendered inside the remote-worker error card. When clicked,
 * it opens a dialog explaining the OpenWork Den upgrade situation and how to
 * reach support.
 */
export function OpenWorkDenHelpLink() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="mt-2 inline-flex items-center text-[11px] font-medium text-blue-11 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        Using OpenWork Den Remote Workers? Click here
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenWork Den remote workers</DialogTitle>
            <DialogDescription>
              We recently upgraded our servers. If your remote worker was
              provisioned before that upgrade, it may no longer be compatible
              with the current OpenWork app.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-[13px] leading-5 text-gray-11">
            <p>To get back online, you have two options:</p>
            <ul className="ml-4 list-disc space-y-2">
              <li>
                Email{" "}
                <a
                  href={SUPPORT_MAILTO}
                  className="font-medium text-blue-11 hover:underline"
                >
                  {SUPPORT_EMAIL}
                </a>{" "}
                and ask us to upgrade your worker.
              </li>
              <li>
                Use the in-app{" "}
                <span className="font-medium text-dls-text">Feedback</span>{" "}
                button to send us a note, and we&apos;ll pick it up from there.
              </li>
            </ul>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Close
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                window.location.href = SUPPORT_MAILTO;
              }}
            >
              Email support
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
