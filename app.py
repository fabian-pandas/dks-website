#!/usr/bin/env python3
import aws_cdk as cdk

from infra.dns_stack import DnsStack
from infra.website_stack import WebsiteStack

ACCOUNT = "975050185731"
DOMAIN = "dks-analytics.de"

env_eu = cdk.Environment(account=ACCOUNT, region="eu-central-1")
env_us = cdk.Environment(account=ACCOUNT, region="us-east-1")

app = cdk.App()

dns = DnsStack(
    app,
    "dks-website-dns",
    env=env_eu,
    domain_name=DOMAIN,
    cross_region_references=True,
)

WebsiteStack(
    app,
    "dks-website-site",
    env=env_us,
    domain_name=DOMAIN,
    hosted_zone_id=dns.hosted_zone.hosted_zone_id,
    hosted_zone_name=DOMAIN,
    cross_region_references=True,
)

# ChatbotStack bauen wir später (eu-central-1):
# from infra.chatbot_stack import ChatbotStack
# ChatbotStack(app, "dks-website-chatbot", env=env_eu, domain_name=DOMAIN, ...)

cdk.Tags.of(app).add("Project", "dks-website")
cdk.Tags.of(app).add("ManagedBy", "cdk")

app.synth()
