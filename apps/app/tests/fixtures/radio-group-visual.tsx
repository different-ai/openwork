/** @jsxImportSource react */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RadioGroup, RadioGroupItem } from "../../src/components/ui/radio-group";

function Fixture() {
  const [value, setValue] = useState("sandbox");
  return <RadioGroup value={value} onValueChange={setValue}>
    <RadioGroupItem value="computer" aria-label="On this computer" />
    <RadioGroupItem value="sandbox" aria-label="In a sandbox (isolated)" />
  </RadioGroup>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(<Fixture />);

const wait = () => new Promise(resolve => setTimeout(resolve, 50));
void (async () => {
  const failures: string[] = [];
  const samples: Array<{ theme: string; selected: string; selectedBackground: string; unselectedBackground: string; indicatorWidth: number; indicatorHeight: number }> = [];
  await wait();
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    for (const choice of ["computer", "sandbox"]) {
      const target = document.querySelector<HTMLElement>(`[role="radio"][aria-label="${choice === "computer" ? "On this computer" : "In a sandbox (isolated)"}"]`);
      target?.click();
      await wait();
      const selected = document.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      const unselected = document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]');
      const indicator = selected?.querySelector<HTMLElement>('[data-slot="radio-group-indicator"]');
      if (!selected || !unselected || !indicator) { failures.push(`${theme}/${choice}: selected indicator missing`); continue; }
      // Checked appearance must follow the semantic state, not a library-specific data attribute.
      selected.removeAttribute("data-checked");
      const selectedBackground = getComputedStyle(selected).backgroundColor;
      const unselectedBackground = getComputedStyle(unselected).backgroundColor;
      const indicatorStyle = getComputedStyle(indicator);
      const box = indicator.getBoundingClientRect();
      samples.push({ theme, selected: choice, selectedBackground, unselectedBackground, indicatorWidth: box.width, indicatorHeight: box.height });
      if (selectedBackground === unselectedBackground) failures.push(`${theme}/${choice}: identical radio backgrounds`);
      if (indicatorStyle.backgroundColor === selectedBackground || indicatorStyle.backgroundColor === "rgba(0, 0, 0, 0)") failures.push(`${theme}/${choice}: invisible indicator`);
      if (box.width !== 8 || box.height !== 8 || indicatorStyle.display === "none" || indicatorStyle.visibility === "hidden") failures.push(`${theme}/${choice}: indicator has no visible 8px dot`);
    }
  }
  const receipt = document.createElement("pre");
  receipt.id = "radio-visual-result";
  receipt.textContent = JSON.stringify({ failures, samples });
  document.body.append(receipt);
})();
