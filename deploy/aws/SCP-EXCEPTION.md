# SCP Exception Request — Perfumes on AWS

## What We're Asking For

The Perfumes platform needs to run in your AWS account (`752796320611`, region `us-east-1`) behind an organizational SCP that **explicitly denies** every way to create or inspect compute resources:

| Action | Why It's Needed | Current SCP Denial |
|---|---|---|
| `cloudformation:ValidateTemplate` | First thing deploy.js does before any stack operation | `p-pzq2xcu4` |
| `cloudformation:DescribeStacks` | Required for `requireStack()` and post-deploy readiness checks | same |
| `ec2:DescribeVpcs` | `instance.bootstrap.sh` needs VPC information; `describe-managed-prefix-lists` also blocked | same |
| `ec2:DescribeManagedPrefixLists` | deploy.js resolves CloudFront origin-facing prefix list from this API | same |
| `ec2:CreateVolume` | data volume (20 GB gp3) is created on first boot | same |
| `ec2:CreateSecurityGroup` | WebSecurityGroup is created in the template | same |
| `s3:CreateBucket` | BackupBucket (retention policy, versioning) is created in the template | same |
| `ssm:GetParameter` | instance reads `/perfumes/env` SecureString on every start | same |
| `ssm:SendCommand` | exec.js runs shell commands via SSM; update.js / migrate.js depend on it | same |

These 9 actions are the only ones that matter for a *create* deployment. Most other actions (S3 object writes, CloudFront reads, Route 53, ACM) are already permitted.

## What This Enables

Once the SCP allows the 9 actions above, the following will succeed automatically:

- **`npm run aws:deploy`** — creates the stack (EC2 + EBS + CloudFront + S3 + SSM)
- **`npm run aws:migrate`** — copies the local SQLite database + uploads to the instance
- **`npm run aws:update`** — rebuilds and restarts the app from a branch
- **`npm run aws:env`** — pushes `.env` changes to SSM and restarts
- **`npm run check:aws:perms`** — confirms every action is permitted before you retry

The template, scripts and runbooks are all ready; only the SCP is the remaining gate.

## Exact SCP ARN to Modify

```
arn:aws:organizations::909421214276:policy/o-snrun5i7ii/service_control_policy/p-pzq2xcu4
```

This policy is attached to organizational unit `o-snrun5i7ii`. The exception needs to cover the exact 9 actions listed above. The safest approach is to add a `Condition` on each statement that permits those actions, or to broaden the policy to `Allow all ec2:` / `Allow all s3:` / `Allow all cloudformation:` / `Allow all ssm:` at the org level — whichever your security team’s approval process accepts.

## Minimal Policy Change (JSON Patch)

If your org admin prefers a targeted edit rather than a blanket allow, here's a minimal JSON patch that adds the needed actions to the existing policy's statements:

```json
[
  {
    "Action": "cloudformation:ValidateTemplate,cloudformation:DescribeStacks",
    "Effect": "Allow",
    "Resource": "*"
  },
  {
    "Action": "ec2:DescribeVpcs,ec2:DescribeManagedPrefixLists,ec2:CreateVolume,ec2:CreateSecurityGroup",
    "Effect": "Allow",
    "Resource": "*"
  },
  {
    "Action": "s3:CreateBucket",
    "Effect": "Allow",
    "Resource": "*"
  },
  {
    "Action": "ssm:GetParameter,ssm:SendCommand",
    "Effect": "Allow",
    "Resource": "*"
  }
]
```

Add these as new Statement entries in the policy so any existing deny for other actions is preserved.

## How to Verify Before and After

Run the preflight before and after the change to confirm:

```bash
# Before (will FAIL):
npm run check:aws:perms

# After — once the SCP exception is applied, should print "All probeable actions are permitted."
npm run check:aws:perms
```

## Who to Contact

This is an organization-wide SCP; the request should go to whoever manages the org unit or management account that owns policy `p-pzq2xcu4`. If you have IAM administrator access, you can also ask them to attach the 4 JSON-patch entries above to the existing policy.

## No Billing Impact During This Work

The investigation up to this point created **zero** chargeable resources: one probe CloudFront distribution was auto-deleted, one probe ACM certificate was requested and immediately deleted, and all S3 bucket/volume/API calls were either dry-runs or targeted at non-existent resources. The only resource that existed before was the Route 53 hosted zone for `synthronixx.space` — which is unusable (domain not registered), so it also carries no cost.