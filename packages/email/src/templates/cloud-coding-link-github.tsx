import React from "react"
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components"

export type CloudCodingLinkGithubProps = { senderName: string; url: string }

export function CloudCodingLinkGithub({ senderName, url }: CloudCodingLinkGithubProps) {
  return <Html><Head /><Preview>Link your GitHub account</Preview><Body><Container>
    <Heading>Link your GitHub account</Heading>
    <Text>{senderName} asked you to link your GitHub account so pull requests OpenWork opens for you are in your name.</Text>
    <Button href={url}>Link your GitHub account</Button>
  </Container></Body></Html>
}
