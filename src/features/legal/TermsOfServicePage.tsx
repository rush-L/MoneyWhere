import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'

const LAST_UPDATED = 'October 31, 2026'
const CONTACT_EMAIL = 'moneywhere.app@gmail.com'

/** Public, no-auth page (spec 17). Rendered before AuthProvider mounts; `onBack` is a plain navigation, not app routing. */
export function TermsOfServicePage({ onBack }: { onBack: () => void }) {
  return (
    <main className="page">
      <PageHeader title="Terms of Service" onBack={onBack} backLabel="MoneyWhere" />
      <div className="card">
        <p className="field-hint">Last updated: {LAST_UPDATED}</p>

        <Section title="Acceptance">
          <p>
            By creating an account or using MoneyWhere, you agree to these terms and to the <a href="/privacy">Privacy
            Policy</a>. If you do not agree, do not use the application.
          </p>
        </Section>

        <Section title="The service">
          <p>
            MoneyWhere is a personal and shared money-tracking application. It is currently operated on free
            infrastructure tiers, is under active development, and is not currently intended as a public,
            general-availability product — features, availability, and these terms may change as the project
            evolves.
          </p>
        </Section>

        <Section title="Your account">
          <p>
            You are responsible for keeping your sign-in credentials secure and for the accuracy of the information
            you provide. You must use a real, accessible email address, since it is used for sign-in confirmation
            and password recovery. You are responsible for all activity carried out from your account.
          </p>
        </Section>

        <Section title="Shared wallets">
          <p>
            A wallet's owner chooses who to invite and can remove members or transfer ownership; a member can leave a
            wallet at any time. Entering a transaction in a shared wallet makes it visible to the other members of
            that wallet. You should only share a wallet with people you intend to share that financial information
            with.
          </p>
        </Section>

        <Section title="Acceptable use">
          <p>
            You agree not to use MoneyWhere to store unlawful content, to attempt to access another user's account
            or wallet without authorization, to interfere with the service's operation, or to misuse the invitation
            system to contact people without their consent.
          </p>
        </Section>

        <Section title="Not financial advice">
          <p>
            MoneyWhere helps you record and organize financial information that you provide. It does not offer
            financial, investment, tax, or legal advice, and any totals, budgets, or summaries it shows are
            calculated only from the data you entered.
          </p>
        </Section>

        <Section title="Availability">
          <p>
            The service is provided on free infrastructure tiers with no guaranteed uptime, no custom domain, and a
            rate-limited email provider. We may suspend, change, or discontinue the service, or any part of it, at
            any time.
          </p>
        </Section>

        <Section title="Data export and deletion">
          <p>
            You can export your data or permanently delete your account at any time from Profile. See the <a
            href="/privacy">Privacy Policy</a> for what deleting your account does to data shared with other wallet
            members.
          </p>
        </Section>

        <Section title="Disclaimer and limitation of liability">
          <p>
            MoneyWhere is provided "as is," without warranties of any kind, express or implied. To the fullest
            extent permitted by law, we are not liable for any loss of data, loss of access, or financial decision
            made using the application.
          </p>
        </Section>

        <Section title="Changes to these terms">
          <p>
            If these terms change, the "Last updated" date above will change. Continued use of MoneyWhere after an
            update means you accept the revised terms.
          </p>
        </Section>

        <Section title="Governing law">
          <p>These terms are governed by the laws of the Republic of the Philippines.</p>
        </Section>

        <Section title="Contact">
          <p>Questions about these terms can be sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
        </Section>
      </div>
    </main>
  )
}
