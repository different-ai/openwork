import {
  parse,
  type AnyNode,
  type CallExpression,
  type Expression,
  type ModuleDeclaration,
  type Pattern,
  type Program,
  type Statement,
  type VariableDeclaration,
} from "acorn"

export type WorkflowGraphNode =
  | { id: string; kind: "input"; label: string; fields: string[] }
  | { id: string; kind: "tool"; label: string; namespace: string; tool: string; scriptPath: string; assignsTo: string | null; parallelGroup: string | null }
  | { id: string; kind: "search"; label: string }
  | { id: string; kind: "branch"; label: string }
  | { id: string; kind: "loop"; label: string }
  | { id: string; kind: "return"; label: string }

export type WorkflowGraphEdge = {
  from: string
  to: string
  label: string | null
  kind: "flow" | "data"
}

export type WorkflowGraph = {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  parseError: string | null
}

type FlowSource = { id: string; label: string | null }
type ToolCall = { call: CallExpression; segments: string[] }

const LABEL_LIMIT = 80
const NODE_METADATA_KEYS = new Set(["end", "loc", "range", "start", "type"])

function truncate(label: string): string {
  const compact = label.replace(/\s+/g, " ").trim()
  return compact.length <= LABEL_LIMIT ? compact : `${compact.slice(0, LABEL_LIMIT - 1)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNode(value: unknown): value is AnyNode {
  return isRecord(value)
    && typeof value.type === "string"
    && typeof value.start === "number"
    && typeof value.end === "number"
}

function forEachChild(node: AnyNode, visit: (child: AnyNode, parent: AnyNode, key: string) => void): void {
  for (const [key, value] of Object.entries(node)) {
    if (NODE_METADATA_KEYS.has(key)) continue
    if (isNode(value)) {
      visit(value, node, key)
      continue
    }
    if (!Array.isArray(value)) continue
    for (const child of value) {
      if (isNode(child)) visit(child, node, key)
    }
  }
}

function walk(node: AnyNode, visit: (node: AnyNode) => void): void {
  visit(node)
  forEachChild(node, (child) => walk(child, visit))
}

function staticPropertyName(node: AnyNode): string | null {
  if (node.type === "Identifier") return node.name
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value)
  }
  return null
}

function memberSegments(node: AnyNode): string[] | null {
  if (node.type === "Identifier") return node.name === "tools" ? [] : null
  if (node.type === "ChainExpression") return memberSegments(node.expression)
  if (node.type !== "MemberExpression") return null
  const parent = memberSegments(node.object)
  if (!parent) return null
  const property = node.computed
    ? staticPropertyName(node.property)
    : node.property.type === "Identifier" ? node.property.name : null
  return property === null ? null : [...parent, property]
}

function toolCall(node: AnyNode): ToolCall | null {
  if (node.type !== "CallExpression") return null
  const segments = memberSegments(node.callee)
  return segments && segments.length > 0 ? { call: node, segments } : null
}

function findToolCalls(node: AnyNode): ToolCall[] {
  const calls: ToolCall[] = []
  const visit = (current: AnyNode) => {
    forEachChild(current, (child) => visit(child))
    const found = toolCall(current)
    if (found) calls.push(found)
  }
  visit(node)
  return calls
}

function unwrapExpression(expression: Expression): Expression {
  if (expression.type === "AwaitExpression") return unwrapExpression(expression.argument)
  if (expression.type === "ChainExpression") return unwrapExpression(expression.expression)
  if (expression.type === "ParenthesizedExpression") return unwrapExpression(expression.expression)
  return expression
}

function promiseAllElements(expression: Expression): Array<Expression | null> | null {
  const unwrapped = unwrapExpression(expression)
  if (unwrapped.type !== "CallExpression" || unwrapped.callee.type !== "MemberExpression") return null
  const callee = unwrapped.callee
  if (callee.computed
    || callee.object.type !== "Identifier"
    || callee.object.name !== "Promise"
    || callee.property.type !== "Identifier"
    || callee.property.name !== "all") return null
  const argument = unwrapped.arguments[0]
  if (!argument || argument.type !== "ArrayExpression") return null
  return argument.elements.map((element) => {
    if (!element) return null
    return element.type === "SpreadElement" ? element.argument : element
  })
}

function identifierFromPattern(pattern: Pattern | null | undefined): string | null {
  return pattern?.type === "Identifier" ? pattern.name : null
}

function referencedIdentifiers(nodes: AnyNode[]): Set<string> {
  const identifiers = new Set<string>()
  const visit = (node: AnyNode, parent: AnyNode | null, key: string | null) => {
    if (node.type === "Identifier") {
      const isMemberProperty = parent?.type === "MemberExpression" && key === "property" && !parent.computed
      const isObjectKey = parent?.type === "Property" && key === "key" && !parent.computed
      if (!isMemberProperty && !isObjectKey) identifiers.add(node.name)
    }
    forEachChild(node, (child, childParent, childKey) => visit(child, childParent, childKey))
  }
  for (const node of nodes) visit(node, null, null)
  return identifiers
}

function inputFields(nodes: AnyNode[]): string[] {
  const fields = new Set<string>()
  for (const root of nodes) {
    walk(root, (node) => {
      if (node.type !== "MemberExpression" || node.object.type !== "Identifier" || node.object.name !== "input") return
      const field = node.computed
        ? staticPropertyName(node.property)
        : node.property.type === "Identifier" ? node.property.name : null
      if (field !== null) fields.add(field)
    })
  }
  return [...fields]
}

class Analyzer {
  readonly nodes: WorkflowGraphNode[] = []
  readonly edges: WorkflowGraphEdge[] = []
  private readonly assignedTools = new Map<string, string>()
  private readonly counters = { branch: 0, loop: 0, return: 0, search: 0, tool: 0 }
  private parallelCount = 0
  private readonly inputNodeId: string | null

  constructor(private readonly code: string, private readonly program: Program) {
    const fields = inputFields([program])
    this.inputNodeId = fields.length > 0 ? "input" : null
    if (this.inputNodeId) this.nodes.push({ id: this.inputNodeId, kind: "input", label: "Input", fields })
  }

  analyze(): WorkflowGraph {
    const incoming = this.inputNodeId ? [{ id: this.inputNodeId, label: null }] : []
    this.processSequence(this.program.body, incoming)
    return { nodes: this.nodes, edges: this.edges, parseError: null }
  }

  private nextId(kind: keyof Analyzer["counters"]): string {
    this.counters[kind] += 1
    return `${kind}${this.counters[kind]}`
  }

  private source(node: AnyNode): string {
    return truncate(this.code.slice(node.start, node.end))
  }

  private connect(sources: FlowSource[], target: string): void {
    for (const source of sources) {
      this.edges.push({ from: source.id, to: target, label: source.label ? truncate(source.label) : null, kind: "flow" })
    }
  }

  private addBranch(label: string, incoming: FlowSource[]): string {
    const id = this.nextId("branch")
    this.nodes.push({ id, kind: "branch", label: truncate(label) })
    this.connect(incoming, id)
    return id
  }

  private processSequence(statements: Array<Statement | ModuleDeclaration>, incoming: FlowSource[]): FlowSource[] {
    let exits = incoming
    for (const statement of statements) exits = this.processStatement(statement, exits)
    return exits
  }

  private processVariableDeclaration(statement: VariableDeclaration, incoming: FlowSource[]): FlowSource[] {
    let exits = incoming
    for (const declaration of statement.declarations) {
      if (declaration.init) exits = this.processExpression(declaration.init, exits, declaration.id)
    }
    return exits
  }

  private processStatement(statement: Statement | ModuleDeclaration, incoming: FlowSource[]): FlowSource[] {
    switch (statement.type) {
      case "BlockStatement":
        return this.processSequence(statement.body, incoming)
      case "VariableDeclaration":
        return this.processVariableDeclaration(statement, incoming)
      case "ExpressionStatement":
        return this.processExpression(statement.expression, incoming, null)
      case "ReturnStatement": {
        const exits = statement.argument
          ? this.processExpression(statement.argument, incoming, null)
          : incoming
        const id = this.nextId("return")
        this.nodes.push({ id, kind: "return", label: this.returnLabel(statement.argument) })
        this.connect(exits, id)
        return []
      }
      case "IfStatement": {
        const tested = this.processExpression(statement.test, incoming, null)
        const branchId = this.addBranch(this.source(statement.test), tested)
        const consequent = this.processStatement(statement.consequent, [{ id: branchId, label: "yes" }])
        const alternate = statement.alternate
          ? this.processStatement(statement.alternate, [{ id: branchId, label: "no" }])
          : [{ id: branchId, label: "no" }]
        return [...consequent, ...alternate]
      }
      case "TryStatement": {
        const branchId = this.addBranch("try", incoming)
        const attempted = this.processStatement(statement.block, [{ id: branchId, label: "try" }])
        const handled = statement.handler
          ? this.processStatement(statement.handler.body, [{ id: branchId, label: "catch" }])
          : []
        const exits = statement.handler ? [...attempted, ...handled] : attempted
        return statement.finalizer ? this.processStatement(statement.finalizer, exits) : exits
      }
      case "WhileStatement":
      case "DoWhileStatement": {
        const tested = this.processExpression(statement.test, incoming, null)
        return this.processLoop(this.source(statement.test), statement.body, tested)
      }
      case "ForStatement": {
        let exits = incoming
        if (statement.init?.type === "VariableDeclaration") exits = this.processVariableDeclaration(statement.init, exits)
        else if (statement.init) exits = this.processExpression(statement.init, exits, null)
        if (statement.test) exits = this.processExpression(statement.test, exits, null)
        if (statement.update) exits = this.processExpression(statement.update, exits, null)
        const label = statement.test ? this.source(statement.test) : "for"
        return this.processLoop(label, statement.body, exits)
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const exits = this.processExpression(statement.right, incoming, null)
        return this.processLoop(this.source(statement.right), statement.body, exits)
      }
      case "ThrowStatement":
        return this.processExpression(statement.argument, incoming, null)
      case "LabeledStatement":
      case "WithStatement":
        return this.processStatement(statement.body, incoming)
      default:
        return incoming
    }
  }

  private processLoop(label: string, body: Statement, incoming: FlowSource[]): FlowSource[] {
    const id = this.nextId("loop")
    this.nodes.push({ id, kind: "loop", label: truncate(label) })
    this.connect(incoming, id)
    const bodyExits = this.processStatement(body, [{ id, label: null }])
    return [{ id, label: null }, ...bodyExits]
  }

  private processExpression(expression: Expression, incoming: FlowSource[], assignment: Pattern | null): FlowSource[] {
    const unwrapped = unwrapExpression(expression)
    if (unwrapped.type === "ConditionalExpression") {
      const tested = this.processExpression(unwrapped.test, incoming, null)
      const branchId = this.addBranch(this.source(unwrapped.test), tested)
      const consequent = this.processExpression(unwrapped.consequent, [{ id: branchId, label: "yes" }], assignment)
      const alternate = this.processExpression(unwrapped.alternate, [{ id: branchId, label: "no" }], assignment)
      return [...consequent, ...alternate]
    }

    const parallel = promiseAllElements(unwrapped)
    if (parallel) return this.processParallel(parallel, incoming, assignment)

    const calls = findToolCalls(unwrapped)
    if (calls.length === 0) return incoming
    const outerCall = toolCall(unwrapped)
    let exits = incoming
    for (const found of calls) {
      const assignsTo = outerCall?.call === found.call ? identifierFromPattern(assignment) : null
      exits = this.addCall(found, exits, assignsTo, null)
    }
    return exits
  }

  private processParallel(elements: Array<Expression | null>, incoming: FlowSource[], assignment: Pattern | null): FlowSource[] {
    const group = `p${++this.parallelCount}`
    const patternElements = assignment?.type === "ArrayPattern" ? assignment.elements : []
    const exits: FlowSource[] = []
    elements.forEach((element, index) => {
      if (!element) return
      const calls = findToolCalls(element)
      if (calls.length === 0) return
      const outerCall = toolCall(unwrapExpression(element))
      let elementExits = incoming
      for (const found of calls) {
        const assignsTo = outerCall?.call === found.call
          ? identifierFromPattern(patternElements[index])
          : null
        elementExits = this.addCall(found, elementExits, assignsTo, group)
      }
      exits.push(...elementExits)
    })
    return exits.length > 0 ? exits : incoming
  }

  private addCall(found: ToolCall, incoming: FlowSource[], assignsTo: string | null, parallelGroup: string | null): FlowSource[] {
    const [namespace, ...toolSegments] = found.segments
    const tool = toolSegments.join(".")
    if (namespace === "$codemode" && tool === "search") {
      const id = this.nextId("search")
      this.nodes.push({ id, kind: "search", label: "Search capabilities" })
      this.connect(incoming, id)
      return [{ id, label: null }]
    }

    const id = this.nextId("tool")
    const scriptPath = `tools.${found.segments.join(".")}`
    this.nodes.push({
      id,
      kind: "tool",
      label: truncate(`${namespace}${tool ? `.${tool}` : ""}`),
      namespace,
      tool,
      scriptPath,
      assignsTo,
      parallelGroup,
    })
    this.connect(incoming, id)

    const argumentsAsNodes = found.call.arguments
    for (const identifier of referencedIdentifiers(argumentsAsNodes)) {
      const source = this.assignedTools.get(identifier)
      if (source) this.edges.push({ from: source, to: id, label: truncate(identifier), kind: "data" })
    }
    if (this.inputNodeId) {
      for (const field of inputFields(argumentsAsNodes)) {
        this.edges.push({ from: this.inputNodeId, to: id, label: truncate(`input.${field}`), kind: "data" })
      }
    }
    if (assignsTo) this.assignedTools.set(assignsTo, id)
    return [{ id, label: null }]
  }

  private returnLabel(argument: Expression | null | undefined): string {
    if (!argument) return "return"
    if (argument.type === "ObjectExpression") {
      const fields = argument.properties.map((property) => {
        if (property.type === "SpreadElement") return "…"
        return staticPropertyName(property.key) ?? this.source(property.key)
      })
      return truncate(`{ ${fields.join(", ")} }`)
    }
    return this.source(argument)
  }
}

export function analyze(code: string): WorkflowGraph {
  try {
    const program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    })
    return new Analyzer(code, program).analyze()
  } catch (error) {
    return {
      nodes: [],
      edges: [],
      parseError: error instanceof Error ? error.message : "Unable to parse Workflow source.",
    }
  }
}

function mermaidLabel(label: string): string {
  return `"${label.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replace(/\s+/g, " ")}"`
}

export function toMermaid(graph: WorkflowGraph): string {
  const lines = ["flowchart TD"]
  for (const node of graph.nodes) {
    const label = mermaidLabel(node.label)
    if (node.kind === "branch" || node.kind === "loop") lines.push(`  ${node.id}{${label}}`)
    else if (node.kind === "input" || node.kind === "return") lines.push(`  ${node.id}([${label}])`)
    else lines.push(`  ${node.id}[${label}]`)
  }
  for (const edge of graph.edges) {
    const arrow = edge.kind === "data" ? "-.->" : "-->"
    const label = edge.label ? `|${mermaidLabel(edge.label)}|` : ""
    lines.push(`  ${edge.from} ${arrow}${label} ${edge.to}`)
  }
  return lines.join("\n")
}
