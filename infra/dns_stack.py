"""
DnsStack — Route53 Hosted Zone für dks-analytics.de + alle nicht-CloudFront-abhängigen Records.

Records aus IONOS migriert. Root- und www-A/AAAA-Aliases liegen im WebsiteStack,
weil sie auf die CloudFront-Distribution zeigen müssen, die dort entsteht.
"""

from aws_cdk import (
    Stack,
    aws_route53 as route53,
)
from constructs import Construct


class DnsStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        domain_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.hosted_zone = route53.PublicHostedZone(
            self,
            "HostedZone",
            zone_name=domain_name,
            comment=f"Authoritative DNS for {domain_name}, migrated from IONOS",
        )

        # ── Microsoft 365 (Exchange Online + Teams + Intune) ──────────────────

        # MX → Exchange Online
        route53.MxRecord(
            self,
            "MxOutlook",
            zone=self.hosted_zone,
            values=[
                route53.MxRecordValue(
                    priority=0,
                    host_name="dksanalytics-de0i.mail.protection.outlook.com",
                ),
            ],
        )

        # SPF (TXT @): IONOS-Include vorerst behalten, NACH Cutover entfernen
        route53.TxtRecord(
            self,
            "Spf",
            zone=self.hosted_zone,
            values=[
                "v=spf1 include:_spf-eu.ionos.com include:spf.protection.outlook.com ~all",
            ],
        )

        # autodiscover → Outlook
        route53.CnameRecord(
            self,
            "Autodiscover",
            zone=self.hosted_zone,
            record_name="autodiscover",
            domain_name="autodiscover.outlook.com",
        )

        # Teams / Skype for Business
        route53.CnameRecord(
            self,
            "Sip",
            zone=self.hosted_zone,
            record_name="sip",
            domain_name="sipdir.online.lync.com",
        )
        route53.CnameRecord(
            self,
            "Lyncdiscover",
            zone=self.hosted_zone,
            record_name="lyncdiscover",
            domain_name="webdir.online.lync.com",
        )
        route53.SrvRecord(
            self,
            "SipTls",
            zone=self.hosted_zone,
            record_name="_sip._tls",
            values=[
                route53.SrvRecordValue(
                    priority=100,
                    weight=1,
                    port=443,
                    host_name="sipdir.online.lync.com",
                ),
            ],
        )
        route53.SrvRecord(
            self,
            "SipFedTls",
            zone=self.hosted_zone,
            record_name="_sipfederationtls._tcp",
            values=[
                route53.SrvRecordValue(
                    priority=100,
                    weight=1,
                    port=5061,
                    host_name="sipfed.online.lync.com",
                ),
            ],
        )

        # Azure AD Device Registration / Intune MDM
        route53.CnameRecord(
            self,
            "EnterpriseRegistration",
            zone=self.hosted_zone,
            record_name="enterpriseregistration",
            domain_name="enterpriseregistration.windows.net",
        )
        route53.CnameRecord(
            self,
            "EnterpriseEnrollment",
            zone=self.hosted_zone,
            record_name="enterpriseenrollment",
            domain_name="enterpriseenrollment-s.manage.microsoft.com",
        )

        # ── DKS Vault (Lightsail static IP, eu-central-1) ─────────────────────

        route53.ARecord(
            self,
            "VaultA",
            zone=self.hosted_zone,
            record_name="vault",
            target=route53.RecordTarget.from_ip_addresses("18.158.96.255"),
        )
        route53.AaaaRecord(
            self,
            "VaultAAAA",
            zone=self.hosted_zone,
            record_name="vault",
            target=route53.RecordTarget.from_ip_addresses(
                "2a05:d014:1aa6:7400:ad27:94e5:8056:5a73"
            ),
        )

        # ── Optional / TODO ───────────────────────────────────────────────────
        # DMARC: nach Anlage scharfschalten (p=none → später p=quarantine → p=reject)
        # route53.TxtRecord(
        #     self,
        #     "Dmarc",
        #     zone=self.hosted_zone,
        #     record_name="_dmarc",
        #     values=["v=DMARC1; p=none; rua=mailto:fabian.stoehr@dks-analytics.de"],
        # )
        #
        # DKIM: Werte aus M365 Admin Center → Email → DKIM kopieren, falls aktiv:
        # route53.CnameRecord(
        #     self, "DkimSelector1",
        #     zone=self.hosted_zone,
        #     record_name="selector1._domainkey",
        #     domain_name="<wert-aus-m365>",
        # )
        # route53.CnameRecord(
        #     self, "DkimSelector2",
        #     zone=self.hosted_zone,
        #     record_name="selector2._domainkey",
        #     domain_name="<wert-aus-m365>",
        # )
