import React from "react"
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components"

export type CloudCodingAdminRequestProps = { requesterName: string; url: string }

export function CloudCodingAdminRequest({ requesterName, url }: CloudCodingAdminRequestProps) {
  return <Html><Head /><Preview>{requesterName} asked to use Cloud coding</Preview><Body><Container>
    <Heading>Cloud coding request</Heading>
    <Text>{requesterName} asked to use Cloud coding.</Text>
    <Button href={url}>Open Cloud coding</Button>
  </Container></Body></Html>
}
