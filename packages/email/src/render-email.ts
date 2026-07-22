import { render } from "@react-email/render"
import { renderEmailTemplate, type EmailTemplate, type EmailTemplateProps } from "./templates/index.js"

export function renderEmailHtml<Template extends EmailTemplate>(
  template: Template,
  props: EmailTemplateProps[Template],
) {
  return render(renderEmailTemplate(template, props))
}
