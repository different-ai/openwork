"use client";

import { useState } from "react";
import { ArrowRight, FileText, Info, Plug, Repeat2 } from "lucide-react";
import { WORK_EXAMPLES } from "../lib/coworker-content";

/** Illustrates connected work without connecting an account or running a task. */
export function CoworkerWorkExamples() {
  const [selected, setSelected] = useState(0);
  const example = WORK_EXAMPLES[selected]!;

  return <div className="cw-work-examples" data-testid="coworker-work-examples">
    <div className="cw-work-examples-top">
      <div><p className="cw-eyebrow">From connection to useful work</p><h3>What would you hand over first?</h3></div>
      <span className="cw-work-example-label">Illustrative examples · No live connections or runs</span>
    </div>
    <div className="cw-work-example-options" role="group" aria-label="Choose an example workflow">
      {WORK_EXAMPLES.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === index} aria-controls="coworker-example-panel" onClick={() => setSelected(index)} data-testid={`work-example-${item.id}`}>{item.label}<ArrowRight size={14} aria-hidden="true" /></button>)}
    </div>
    <div id="coworker-example-panel" className="cw-work-example-panel" role="region" aria-label={`${example.label} example`}>
      <div className="cw-work-example-brief">
        <div className="cw-work-example-inputs" aria-label="Example inputs">{example.inputs.map((input) => <span key={input}><Plug size={13} aria-hidden="true" />{input}</span>)}</div>
        <p className="cw-work-example-description">{example.text}</p>
        <blockquote data-testid="work-example-request">“{example.request}”</blockquote>
        <div className="cw-work-example-result"><FileText size={21} aria-hidden="true" /><div><span>What you’re working toward</span><p data-testid="work-example-result">{example.result}</p></div></div>
      </div>
      <div className="cw-work-example-method">
        <ol>{example.steps.map((item, index) => <li key={item.title}><span className="cw-work-step-number" aria-hidden="true">{index + 1}</span><div><h4>{item.title}</h4><p>{item.detail}</p></div></li>)}</ol>
        <p className="cw-work-example-scope" data-testid="work-example-scope"><Info size={15} aria-hidden="true" /><span>{example.scope}</span></p>
      </div>
    </div>
    <div className="cw-work-example-footer"><Repeat2 size={16} aria-hidden="true" /><span>Connect the tools. Keep the method. Review the work.</span></div>
  </div>;
}
