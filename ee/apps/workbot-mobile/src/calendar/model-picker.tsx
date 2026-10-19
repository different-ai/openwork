import type { AutomationModelOption } from "@openwork/types/automation-models"
import type { AutomationModel } from "@openwork/types/automations"
import { Check, ChevronDown } from "lucide-react-native"
import { useMemo, useState } from "react"
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { QuietButton } from "../ui/controls"
import { color } from "../theme"

/** Lists longer than this get a search field. */
const SEARCH_THRESHOLD = 8

const same = (option: AutomationModelOption, model: AutomationModel | null) => Boolean(model) && option.providerId === model?.providerId && option.modelId === model?.modelId

/** One line for a model: its name and provider; the raw id when it is no longer offered. */
export function modelLabel(model: AutomationModel, options: readonly AutomationModelOption[]) {
  const option = options.find((entry) => same(entry, model))
  return option ? `${option.modelName} · ${option.providerName}` : model.modelId
}

/** Which model an Automation uses: the current one, and the models this member may use, by provider, searchable. */
export function ModelPicker({ value, options, loading, onChange }: { value: AutomationModel; options: readonly AutomationModelOption[]; loading: boolean; onChange: (model: AutomationModel) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const insets = useSafeAreaInsets()
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase()
    return text ? options.filter((option) => `${option.modelName} ${option.providerName}`.toLowerCase().includes(text)) : options
  }, [options, query])
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${modelLabel(value, options)}`} onPress={() => setOpen(true)} style={styles.field}>
        <Text numberOfLines={1} style={styles.fieldText}>{loading ? "Loading models" : modelLabel(value, options)}</Text>
        <ChevronDown size={14} strokeWidth={1.75} color={color.muted} />
      </Pressable>
      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}>
          <View style={styles.head}>
            <Text accessibilityRole="header" style={styles.title}>Model</Text>
            <QuietButton label="Done" onPress={() => setOpen(false)} />
          </View>
          {options.length > SEARCH_THRESHOLD ? (
            <TextInput value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={color.muted} accessibilityLabel="Search models" style={styles.search} />
          ) : null}
          <FlatList
            data={shown}
            keyExtractor={(option) => `${option.providerId}/${option.modelId}`}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: same(item, value) }}
                onPress={() => {
                  onChange({ providerId: item.providerId, modelId: item.modelId, variant: null })
                  setOpen(false)
                }}
                style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
              >
                <View style={styles.rowText}>
                  <Text style={styles.model}>{item.modelName}</Text>
                  <Text style={styles.provider}>{item.providerName}</Text>
                </View>
                {same(item, value) ? <Check size={16} strokeWidth={2} color={color.ink} /> : null}
              </Pressable>
            )}
            ListEmptyComponent={<Text style={styles.empty}>{loading ? "Loading models" : "No model has that name."}</Text>}
          />
        </View>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  field: { height: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: color.surface, boxShadow: "inset 0 0 0 1px #0116271F" },
  fieldText: { flex: 1, fontSize: 14, color: color.text },
  sheet: { flex: 1, backgroundColor: color.surface, paddingTop: 16 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 15, fontWeight: "600", color: color.text },
  search: { marginHorizontal: 16, marginBottom: 8, height: 38, paddingHorizontal: 14, borderRadius: 999, backgroundColor: color.chip, fontSize: 14, color: color.text },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 12 },
  pressed: { backgroundColor: color.chip },
  rowText: { flex: 1, gap: 2 },
  model: { fontSize: 15, color: color.text },
  provider: { fontSize: 12, color: color.muted },
  empty: { padding: 20, fontSize: 13, color: color.muted },
})
