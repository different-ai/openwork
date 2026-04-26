import Eyebrow from "./eyebrow";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

type FaqItem = {
  title: string;
  content: string | string[];
};

type FaqsSectionProps = {
  faqs: FaqItem[];
};

const FaqsSection = ({ faqs }: FaqsSectionProps) => {
  return (
    <section>
      <div className="grid-12 px-(--container-px)">
        <div className="col-span-12 col-start-1 flex flex-col gap-[6.4rem] md:col-span-6 md:col-start-4">
          <div className="gap-base flex flex-col items-center text-center">
            <div className="gap-base flex flex-col items-center">
              <Eyebrow>FAQS</Eyebrow>
              <h1 data-split="heading" className="h2">
                Frequently Asked <span className="h2-serif">Questions</span>
              </h1>
            </div>
            <p data-split="heading" className="body-base">
              Quick answers about installation, providers, security, team distribution, and how OpenWork compares to
              closed cowork tools.
            </p>
          </div>

          <Accordion data-reveal-group type="single" collapsible className="w-full" defaultValue="item-1">
            {faqs.map((faq, index) => (
              <AccordionItem key={index} value={`item-${index + 1}`}>
                <AccordionTrigger>{faq.title}</AccordionTrigger>
                <AccordionContent className="flex flex-col gap-4 text-balance">
                  {Array.isArray(faq.content) ? (
                    faq.content.map((paragraph, idx) => <p key={idx}>{paragraph}</p>)
                  ) : (
                    <p>{faq.content}</p>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
};

export default FaqsSection;
