"""
WebsiteStack — S3 + CloudFront + ACM + Route53-Aliases für dks-analytics.de.

Deployt nach us-east-1, weil das ACM-Cert für CloudFront zwingend dort liegen
muss. CloudFront selbst ist global; die User in DACH bekommen sie aus dem
Edge-PoP Frankfurt, nicht aus Virginia.

Site-Files in ./site/ werden per BucketDeployment hochgeladen, Cache wird
nach Deploy invalidiert.
"""

import json
from datetime import datetime, timezone

from aws_cdk import (
    Stack,
    RemovalPolicy,
    Duration,
    aws_s3 as s3,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_certificatemanager as acm,
    aws_route53 as route53,
    aws_route53_targets as targets,
    aws_s3_deployment as s3deploy,
)
from constructs import Construct


class WebsiteStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        domain_name: str,
        hosted_zone_id: str,
        hosted_zone_name: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # Hosted Zone aus dem DnsStack referenzieren (cross-region, by attrs).
        zone = route53.HostedZone.from_hosted_zone_attributes(
            self,
            "Zone",
            hosted_zone_id=hosted_zone_id,
            zone_name=hosted_zone_name,
        )

        # ACM-Cert (us-east-1, DNS-validiert über Route53).
        certificate = acm.Certificate(
            self,
            "Cert",
            domain_name=domain_name,
            subject_alternative_names=[f"www.{domain_name}"],
            validation=acm.CertificateValidation.from_dns(zone),
        )

        # Origin-Bucket. Privat + OAC. Niemals manuell befüllen — CDK deployed.
        bucket = s3.Bucket(
            self,
            "SiteBucket",
            bucket_name=f"dks-website-site-{self.account}-{self.region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            versioned=False,
            removal_policy=RemovalPolicy.RETAIN,
            auto_delete_objects=False,
        )

        # CloudFront-Function (viewer-response): hängt `charset=utf-8` an
        # text/html Content-Types an. S3 setzt nur `text/html` ohne charset,
        # was Seobility und manche User-Agents als SEO-Warning werten.
        html_charset = cloudfront.Function(
            self,
            "AppendHtmlCharset",
            comment="Append charset=utf-8 to text/html Content-Type",
            code=cloudfront.FunctionCode.from_inline(
                "function handler(event) {\n"
                "  var response = event.response;\n"
                "  var headers = response.headers;\n"
                "  var ct = headers['content-type'];\n"
                "  if (ct && ct.value && ct.value.indexOf('text/html') !== -1 && ct.value.indexOf('charset') === -1) {\n"
                "    headers['content-type'] = { value: 'text/html; charset=utf-8' };\n"
                "  }\n"
                "  return response;\n"
                "}\n"
            ),
        )

        # CloudFront-Function: 301 von Apex → www, damit eine kanonische URL gewinnt.
        redirect_to_www = cloudfront.Function(
            self,
            "RedirectApexToWww",
            comment="301 redirect from apex (dks-analytics.de) to www subdomain",
            code=cloudfront.FunctionCode.from_inline(
                "function handler(event) {\n"
                "  var request = event.request;\n"
                "  var hostHeader = request.headers.host;\n"
                "  if (!hostHeader) { return request; }\n"
                f"  if (hostHeader.value === '{domain_name}') {{\n"
                "    var qs = '';\n"
                "    if (request.querystring && Object.keys(request.querystring).length > 0) {\n"
                "      var parts = [];\n"
                "      for (var k in request.querystring) {\n"
                "        parts.push(k + '=' + request.querystring[k].value);\n"
                "      }\n"
                "      qs = '?' + parts.join('&');\n"
                "    }\n"
                "    return {\n"
                "      statusCode: 301,\n"
                "      statusDescription: 'Moved Permanently',\n"
                f"      headers: {{ location: {{ value: 'https://www.{domain_name}' + request.uri + qs }} }}\n"
                "    };\n"
                "  }\n"
                "  return request;\n"
                "}\n"
            ),
        )

        # CloudFront-Distribution.
        # default_root_object="index.html" → / liefert index.html
        # Für /Impressum, /Datenschutz, /Karriere ohne .html: könnte später eine
        # CloudFront Function ergänzt werden, vorerst lieferst du sie inkl. .html.
        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            comment=f"DKS Analytics website — {domain_name}",
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(bucket),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cached_methods=cloudfront.CachedMethods.CACHE_GET_HEAD,
                compress=True,
                function_associations=[
                    cloudfront.FunctionAssociation(
                        function=redirect_to_www,
                        event_type=cloudfront.FunctionEventType.VIEWER_REQUEST,
                    ),
                    cloudfront.FunctionAssociation(
                        function=html_charset,
                        event_type=cloudfront.FunctionEventType.VIEWER_RESPONSE,
                    ),
                ],
            ),
            default_root_object="index.html",
            domain_names=[domain_name, f"www.{domain_name}"],
            certificate=certificate,
            minimum_protocol_version=cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            http_version=cloudfront.HttpVersion.HTTP2_AND_3,
            price_class=cloudfront.PriceClass.PRICE_CLASS_100,  # NA + EU, billiger als ALL
            error_responses=[
                cloudfront.ErrorResponse(
                    http_status=403,
                    response_http_status=404,
                    response_page_path="/index.html",
                    ttl=Duration.minutes(5),
                ),
                cloudfront.ErrorResponse(
                    http_status=404,
                    response_http_status=404,
                    response_page_path="/index.html",
                    ttl=Duration.minutes(5),
                ),
            ],
        )

        # Route53 Aliases für Apex und www → CloudFront.
        cf_target = route53.RecordTarget.from_alias(targets.CloudFrontTarget(distribution))
        for sub in [None, "www"]:
            id_suffix = "Apex" if sub is None else "Www"
            kwargs_record = dict(zone=zone, target=cf_target)
            if sub:
                kwargs_record["record_name"] = sub
            route53.ARecord(self, f"AliasA{id_suffix}", **kwargs_record)
            route53.AaaaRecord(self, f"AliasAAAA{id_suffix}", **kwargs_record)

        # build.json wird beim synth mit aktuellem UTC-Timestamp generiert und
        # neben den Site-Files deployed. Frontend liest /build.json und zeigt
        # "Stable Xd" — ehrliches Signal "läuft ohne Redeploy seit X Tagen".
        build_info = json.dumps(
            {"deployedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        )

        # Site-Files nach S3 deployen + CloudFront-Cache invalidieren.
        s3deploy.BucketDeployment(
            self,
            "DeploySite",
            sources=[
                s3deploy.Source.asset("./site"),
                s3deploy.Source.data("build.json", build_info),
            ],
            destination_bucket=bucket,
            distribution=distribution,
            distribution_paths=["/*"],
            prune=True,
            cache_control=[
                s3deploy.CacheControl.from_string("public, max-age=300, must-revalidate"),
            ],
        )
