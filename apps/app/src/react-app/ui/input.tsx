import * as React from "react";

import { cn } from "../lib/cn";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => {
  return <input className={cn("ow-input", className)} ref={ref} {...props} />;
});
Input.displayName = "Input";

export { Input };
