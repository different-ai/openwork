/** @jsxImportSource react */
import { ProviderIcon as SharedProviderIcon, type ProviderIconProps } from "@openwork/ui/provider-icon"

export type { ProviderIconProps }
export { OpenWorkMark } from "@openwork/ui/provider-icon"

export function ProviderIcon(props: ProviderIconProps) {
  return <SharedProviderIcon monogramClassName="bg-gray-3 text-gray-11" {...props} />
}
