import type { Metadata } from 'next'
import { BundleLimits } from '@app/_components/marketing/bundle-limits'
import { CtaStrip } from '@app/_components/marketing/cta-strip'
import { FaqList } from '@app/_components/marketing/faq-list'
import { MarketingHero } from '@app/_components/marketing/marketing-hero'
import { MarketingNav } from '@app/_components/marketing/marketing-nav'
import { PrivacyLevels } from '@app/_components/marketing/privacy-levels'
import { SelfHostBlock } from '@app/_components/marketing/self-host-block'
import { SiteColophon } from '@app/_components/marketing/site-colophon'
import { WorkflowStage } from '@app/_components/marketing/workflow-stage'

export const metadata: Metadata = {
  title: 'enclave — generate an artifact, decide who can open it',
  description:
    'Self-hosted artifact generation and hosting. One prompt writes a multi-file HTML page; you choose whether it is private, visible to your instance, or open to anyone holding a revocable link.',
}

/**
 * Public landing page. Narrative Workflow (design.md § Marketing page structure): four numbered
 * stages, with 3.0 carrying the weight because the three audiences are the product.
 */
export default function MarketingPage() {
  return (
    <>
      <MarketingNav />
      <main>
        <MarketingHero />

        <WorkflowStage
          id="describe"
          number="1.0"
          heading="Describe it"
          lede="One prompt, in plain language, for the thing you want to exist."
          weight="normal"
        >
          <p>
            You are asking for a page, not a conversation. A prompt like “a countdown to the end of
            the quarter, with the working days left” is enough — enclave sends it to whichever model
            the instance is configured for, along with a system prompt that fixes the output format.
          </p>
          <p>
            There is no chat thread to maintain and no context to lose. If the result is wrong, you
            write a better prompt and generate again; the old artifact stays where it is until you
            delete it.
          </p>
        </WorkflowStage>

        <WorkflowStage
          id="generate"
          number="2.0"
          heading="Watch it arrive file by file"
          lede="The model streams tagged file blocks, and enclave parses them as they land."
          weight="normal"
        >
          <p>
            Output arrives as <code>&lt;file path=&quot;…&quot;&gt;</code> blocks rather than one
            opaque document, so the page you are watching names each file as it starts, shows its
            byte count when it closes, and tells you plainly when the model breaks format instead of
            saving something half-written.
          </p>
          <p>
            Bundles are bounded, an allowlist decides which extensions are accepted, and no path may
            escape the artifact’s own prefix. Nothing becomes readable until every file has been
            written: the version row is created <code>pending</code>, the objects go to storage, and
            only then does it flip to <code>ready</code>. A generation you cancel halfway leaves
            nothing behind.
          </p>
          <BundleLimits />
        </WorkflowStage>

        <WorkflowStage
          id="audience"
          number="3.0"
          heading="Choose who sees it"
          lede="Three audiences, set per artifact, each with a way back. This is the part that is not like a hosted notebook."
          weight="lead"
          wide
        >
          <PrivacyLevels />
          <p>
            One authorization function answers every read, whichever door the reader came through —
            a signed-in member, a share link, or an API token. Each artifact is served from its own
            hostname inside a sandboxed frame, so artifact code cannot read your session or another
            artifact’s storage. Visibility changes and non-private views are appended to an audit log
            the application cannot rewrite. Your prompts are never written to it.
          </p>
        </WorkflowStage>

        <WorkflowStage
          id="revoke"
          number="4.0"
          heading="Share, then take it back"
          lede="A link is a capability, not a permanent publication."
          weight="normal"
        >
          <p>
            A share link carries a 32-byte token; only its hash is stored, and the value is shown to
            you exactly once. It is pinned to one version, so the artifact a reader sees does not
            change under them, and you can give it an expiry date when you create it.
          </p>
          <p>
            Revoking is not a queued job. The document itself is proxied through the app, so the
            next load stops immediately; the assets around it are presigned for 60 seconds, so an
            already-open tab loses them within a minute. Deleting removes the artifact from every
            read path — including yours — and revokes every link it had. You have 30 days to restore
            it, after which a purge job removes the rows and every object from the bucket.
          </p>
        </WorkflowStage>

        <SelfHostBlock />
        <FaqList />
        <CtaStrip />
      </main>
      <SiteColophon />
    </>
  )
}
