import { describe, expect, it } from "vitest";

import { normalizeLeadPayload } from "@/lib/validation/lead";

/**
 * The scraper's documented contact_information link lists were sent as bare
 * URL strings. The dashboard's `records()` helper only kept objects, so those
 * entries vanished before they were stored or turned into contacts. A lead
 * could therefore be created with an empty contact list even though the
 * research answer named a company page or LinkedIn profile.
 */
describe("contact_information link lists", () => {
  const payload = {
    job_information: {
      job_id: "~02124125626153755079",
      job_title: "3D animator for a warehouse robot",
      job_description: "Twelve short clips of an autonomous mobile robot.",
      job_url: "https://www.upwork.com/jobs/~02124125626153755079",
      industry: "Manufacturing",
      job_location: "Remote",
      company_mentioned: "Forkline Tech",
    },
    upwork_client: { client_name: "Forkline Tech", location: "United States" },
    key_people: [
      {
        name: "Dana Reed",
        role: "Founder",
        confidence: "HIGH",
        linkedin_url: "https://www.linkedin.com/in/dana-reed",
      },
    ],
    contact_information: {
      verified_contacts: ["dana@forkline.io"],
      potential_contacts: [],
      company_contact_pages: ["https://forkline.io/contact"],
      linkedin_profiles: ["https://www.linkedin.com/company/forkline-tech"],
      social_media_profiles: ["https://x.com/forkline"],
    },
    overall_confidence: "HIGH",
  };

  it("keeps bare strings in the stored contact information", () => {
    const lead = normalizeLeadPayload(payload);

    expect(lead.contactInformation.company_contact_pages).toEqual([
      { url: "https://forkline.io/contact", type: "company page" },
    ]);
    expect(lead.contactInformation.linkedin_profiles).toEqual([
      {
        url: "https://www.linkedin.com/company/forkline-tech",
        type: "linkedin",
      },
    ]);
    expect(lead.contactInformation.social_media_profiles).toEqual([
      { url: "https://x.com/forkline", type: "social" },
    ]);
    expect(lead.contactInformation.verified_contacts).toEqual([
      { contact_value: "dana@forkline.io", type: "contact" },
    ]);
  });

  it("accepts one string, one object and a wrapped list", () => {
    const lead = normalizeLeadPayload({
      job_information: {
        job_id: "~02124125626153755080",
        job_title: "Product film",
        job_description: "A launch film.",
        job_url: "https://www.upwork.com/jobs/~02124125626153755080",
      },
      contact_information: {
        verified_contacts: "dana@forkline.io",
        potential_contacts: { name: "Sam", contact_value: "sam@forkline.io" },
        company_contact_pages: {
          urls: ["https://forkline.io/contact", { url: "https://forkline.io/about" }],
        },
        linkedin_profiles: "https://www.linkedin.com/company/forkline-tech",
        social_media_profiles: { url: "https://x.com/forkline" },
      },
      overall_confidence: "HIGH",
    });

    expect(lead.contactInformation.verified_contacts).toEqual([
      { contact_value: "dana@forkline.io", type: "contact" },
    ]);
    expect(lead.contactInformation.potential_contacts).toEqual([
      { name: "Sam", contact_value: "sam@forkline.io" },
    ]);
    expect(lead.contactInformation.company_contact_pages).toEqual([
      { url: "https://forkline.io/contact", type: "company page" },
      { url: "https://forkline.io/about", type: "company page" },
    ]);
    expect(lead.contactInformation.linkedin_profiles).toEqual([
      { url: "https://www.linkedin.com/company/forkline-tech", type: "linkedin" },
    ]);
    expect(lead.contactInformation.social_media_profiles).toEqual([
      { url: "https://x.com/forkline", type: "social" },
    ]);
  });

  it("turns every string into a reachable contact", () => {
    const lead = normalizeLeadPayload(payload);
    const values = lead.contacts.map((contact) => contact.contactValue);

    expect(values).toContain("dana@forkline.io");
    expect(values).toContain("https://forkline.io/contact");
    expect(values).toContain("https://www.linkedin.com/company/forkline-tech");
    expect(values).toContain("https://x.com/forkline");
    expect(lead.contacts.find((c) => c.contactValue === "dana@forkline.io")?.isEmail).toBe(true);
    expect(lead.primaryEmail?.contactValue).toBe("dana@forkline.io");
  });
});
