# SCP Exception Request — Perfumes on AWS

## What We're Asking For

The Perfumes platform needs to run in your AWS account (tested in both
`752796320611` and `856324327908`, region `us-east-1`) behind an organizational
SCP that **explicitly denies** every way to create or inspect compute resources.
Both accounts are affected because the deny is attached to the organization OU
`o-snrun5i7ii`, not to a single account — switching accounts does not help.
Verified by `npm run check:aws:perms` on 2026-11-20: the same 9 actions fail in
both accounts with the same policy ARN.

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

This policy is attached to organizational unit `o-snrun5i7ii`.

## Important: adding "Allow" statements will NOT work

The failures are caused by an explicit **Deny**, and an explicit Deny always wins
over an Allow. Adding `Effect: Allow` statements does nothing. The admin must
**remove or narrow the Deny statement itself**. There are three valid options:

**Option A — simplest (recommended):** delete the Deny statement from
`p-pzq2xcu4` (or detach the policy from OU `o-snrun5i7ii`). This restores full
access. Re-attach any remaining deny rules you still want afterwards.

**Option B — narrow by action:** edit the Deny statement's `Action` list and
remove these 9 actions from it:

```
cloudformation:ValidateTemplate
cloudformation:DescribeStacks
ec2:DescribeVpcs
ec2:DescribeManagedPrefixLists
ec2:CreateVolume
ec2:CreateSecurityGroup
s3:CreateBucket
ssm:GetParameter
ssm:SendCommand
```

**Option C — narrow by account:** add a `Condition` to the Deny statement so it
does not apply to this account, e.g.:

```json
"Condition": {
  "StringNotEquals": {
    "aws:PrincipalAccount": "856324327908"
  }
}
```

After any of these, run `npm run check:aws:perms` to confirm.

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