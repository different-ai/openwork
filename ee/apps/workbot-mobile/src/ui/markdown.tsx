import { Lexer, type MarkedToken, type Token, type Tokens } from "marked"
import { Fragment, type ReactNode } from "react"
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native"
import { color } from "../theme"

/**
 * An answer's Markdown as native text. Model output can carry text from anywhere (a page, an email, a message), so it
 * is the web page's rules: raw HTML shows as text, and links open only http(s) and mailto.
 */

const KNOWN = new Set<string>([
  "blockquote", "br", "checkbox", "code", "codespan", "def", "del", "em", "escape", "heading", "hr", "html",
  "image", "link", "list", "list_item", "paragraph", "space", "strong", "table", "text",
])

function isMarked(token: Token): token is MarkedToken {
  return KNOWN.has(token.type)
}

function safeHref(href: string) {
  try {
    const url = new URL(href)
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null
  } catch {
    return null
  }
}

function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((token, index) => <Fragment key={index}>{inlineToken(token)}</Fragment>)
}

function inlineToken(token: Token): ReactNode {
  if (!isMarked(token)) return "raw" in token && typeof token.raw === "string" ? token.raw : null
  switch (token.type) {
    case "strong":
      return <Text style={styles.strong}>{inline(token.tokens)}</Text>
    case "em":
      return <Text style={styles.em}>{inline(token.tokens)}</Text>
    case "del":
      return <Text style={styles.del}>{inline(token.tokens)}</Text>
    case "codespan":
      return <Text style={styles.codespan}>{token.text}</Text>
    case "br":
      return "\n"
    case "link": {
      const href = safeHref(token.href)
      return href ? (
        <Text style={styles.link} accessibilityRole="link" onPress={() => void Linking.openURL(href)}>
          {inline(token.tokens)}
        </Text>
      ) : inline(token.tokens)
    }
    case "image":
      return token.text
    case "text":
      return token.tokens ? inline(token.tokens) : token.text
    case "escape":
    case "html":
      return token.text
    default:
      return token.raw
  }
}

function listItem(token: Tokens.List, item: Tokens.ListItem, itemIndex: number) {
  const content = item.tokens.flatMap((child, childIndex): ReactNode[] =>
    child.type === "checkbox"
      ? []
      : child.type === "text"
        ? [<Text key={childIndex} style={styles.body}>{inlineToken(child)}</Text>]
        : item.task && child.type === "paragraph" && isMarked(child) && "tokens" in child
          ? [<Text key={childIndex} style={styles.body}>{inline(child.tokens)}</Text>]
          : [block(child, childIndex)],
  )
  return (
    <View key={itemIndex} style={styles.listItem}>
      {item.task ? (
        <View accessibilityLabel={item.checked ? "Done" : "Not done"} style={[styles.checkbox, item.checked ? styles.checked : null]} />
      ) : (
        <Text style={[styles.body, styles.bullet, token.ordered ? styles.number : null]}>
          {token.ordered ? `${(typeof token.start === "number" ? token.start : 1) + itemIndex}.` : "•"}
        </Text>
      )}
      <View style={styles.listContent}>{content}</View>
    </View>
  )
}

function block(token: Token, index: number): ReactNode {
  if (!isMarked(token)) return null
  switch (token.type) {
    case "space":
    case "def":
      return null
    case "paragraph":
      return <Text key={index} selectable style={styles.body}>{inline(token.tokens)}</Text>
    case "heading":
      return <Text key={index} selectable style={[styles.body, styles.strong]}>{inline(token.tokens)}</Text>
    case "hr":
      return <View key={index} style={styles.hr} />
    case "blockquote":
      // A quoted draft: a quiet bar, the words in full ink.
      return (
        <View key={index} style={styles.quote}>
          <View style={styles.quoteBar} />
          <View style={styles.quoteBody}>{token.tokens.map(block)}</View>
        </View>
      )
    case "code":
      return (
        <ScrollView key={index} horizontal style={styles.code} contentContainerStyle={styles.codeContent}>
          <Text selectable style={styles.codeText}>{token.text}</Text>
        </ScrollView>
      )
    case "list":
      return <View key={index} style={styles.list}>{token.items.map((item, itemIndex) => listItem(token, item, itemIndex))}</View>
    case "table":
      return (
        <ScrollView key={index} horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={styles.row}>
              {token.header.map((cell, cellIndex) => <Text key={cellIndex} style={[styles.cell, styles.strong]}>{inline(cell.tokens)}</Text>)}
            </View>
            {token.rows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.row}>
                {row.map((cell, cellIndex) => <Text key={cellIndex} style={styles.cell}>{inline(cell.tokens)}</Text>)}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    case "html":
      return <Text key={index} style={styles.body}>{token.text}</Text>
    default:
      return <Text key={index} style={styles.body}>{inlineToken(token)}</Text>
  }
}

export function WorkbotMarkdown({ text }: { text: string }) {
  const tokens = Lexer.lex(text, { gfm: true, breaks: true })
  return <View style={styles.root}>{tokens.map(block)}</View>
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  body: { fontSize: 15, lineHeight: 24, color: color.text },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  codespan: { fontFamily: "Menlo", fontSize: 12, backgroundColor: color.chip },
  link: { textDecorationLine: "underline", textDecorationColor: color.disabled },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: color.disabled },
  quote: { flexDirection: "row", gap: 12 },
  quoteBar: { width: 2, borderRadius: 1, backgroundColor: color.disabled },
  quoteBody: { flexShrink: 1, gap: 6 },
  code: { borderRadius: 12, backgroundColor: color.chip },
  codeContent: { paddingHorizontal: 12, paddingVertical: 8 },
  codeText: { fontFamily: "Menlo", fontSize: 12, lineHeight: 20, color: color.text },
  list: { gap: 4 },
  listItem: { flexDirection: "row", gap: 8 },
  listContent: { flexShrink: 1, gap: 6 },
  bullet: { color: color.muted, minWidth: 10 },
  number: { minWidth: 16, fontVariant: ["tabular-nums"] },
  checkbox: { marginTop: 5, width: 14, height: 14, borderRadius: 4, borderWidth: 1, borderColor: color.muted },
  checked: { borderColor: color.ink, backgroundColor: color.ink },
  row: { flexDirection: "row" },
  cell: { minWidth: 80, paddingVertical: 6, paddingRight: 16, fontSize: 13, lineHeight: 20, color: color.text, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.disabled },
})
