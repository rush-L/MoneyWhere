import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'

const LAST_UPDATED = 'October 31, 2026'
const CONTACT_EMAIL = 'reambillo.russel@gmail.com'

/** Public, no-auth page (spec 17). Rendered before AuthProvider mounts; `onBack` is a plain navigation, not app routing. */
export function PrivacyPolicyPage({ onBack }: { onBack: () => void }) {
  return (
    <main className="page">
      <PageHeader title="Privacy Policy" onBack={onBack} backLabel="MoneyWhere" />
      <div className="card">
        <p className="field-hint">Last updated: {LAST_UPDATED}</p>

        <Section title="Overview">
          <p>
            MoneyWhere is a personal and shared money-tracking application. This policy explains what information we
            collect, how it is used, who can see it, and how you can export or delete it. It is written for
            transparency and is not a substitute for professional legal advice.
          </p>
        </Section>

        <Section title="Information we collect">
          <p>
            <strong>Account and profile data:</strong> your email address (used for sign-in and account recovery),
            and the display name and avatar image URL you choose to set.
          </p>
          <p>
            <strong>Financial data you enter:</strong> wallets, accounts, categories, budgets, and transactions,
            including amounts, dates, notes, and who paid or received each transaction. You control what you enter;
            we do not pull financial data from any external source.
          </p>
        </Section>

        <Section title="What co-members can see">
          <p>
            If you join a shared wallet, the other members of that wallet can see your <strong>display name and
            avatar image</strong>, and the transactions, accounts, categories, and budgets within that wallet. They
            cannot see your email address, your password, or any wallet you have not shared with them.
          </p>
        </Section>

        <Section title="How we use your information">
          <p>
            Your data is used only to provide the application's features: signing you in, showing your balances and
            budgets, syncing changes across your devices, and letting shared-wallet members see the entries you make
            in wallets they also belong to. We do not sell your data or use it for advertising.
          </p>
        </Section>

        <Section title="Where your data is processed">
          <p>
            MoneyWhere uses two infrastructure providers to operate:
          </p>
          <ul>
            <li><strong>Supabase</strong> — authentication, database, and realtime sync.</li>
            <li><strong>Vercel</strong> — application hosting and content delivery.</li>
          </ul>
          <p>Neither provider is given access to your data beyond what is needed to run the service.</p>
        </Section>

        <Section title="Data retention and account deletion">
          <p>
            Deleting your account removes your profile, including your display name and avatar. Any wallet where you
            are the sole member is deleted entirely, along with its accounts, categories, budgets, and transactions.
          </p>
          <p>
            For wallets you share with other members: if you own a shared wallet, deletion is blocked until you
            transfer ownership, remove the other members, or delete the wallet, so another member's financial
            records are never deleted without their knowledge. If you are a member (not owner) of a shared wallet,
            your membership ends automatically, and transactions you created or paid are kept for the wallet's
            history but with your identity removed — they display to other members as <strong>"Former
            member"</strong>, with no name, email, or avatar attached.
          </p>
        </Section>

        <Section title="Your rights and choices">
          <p>
            You can update your display name and avatar at any time from Profile. You can download a copy of your
            data as a JSON file ("Export my data") covering your profile, your wallets, and the accounts,
            categories, budgets, and transactions in them. You can permanently delete your account from Profile;
            we offer the export first so you have a copy before you do.
          </p>
          <p>
            If you are in the Philippines, these choices are intended to reflect your rights under the Data Privacy
            Act of 2012 (R.A. 10173) — including the rights to access, correct, and erase your personal data, and to
            receive a copy of it in a portable format.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Access to financial data is enforced by database-level authorization rules tied to wallet membership,
            not just by the application's interface. Passwords are never stored by MoneyWhere directly — sign-in and
            password recovery are handled by Supabase Auth.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If this policy changes, the "Last updated" date above will change. Continued use of MoneyWhere after an
            update means you accept the revised policy.
          </p>
        </Section>

        <Section title="Contact">
          <p>Questions about this policy or your data can be sent to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
        </Section>
      </div>
      <p className="field-hint">See also the <a href="/terms">Terms of Service</a>.</p>
    </main>
  )
}
