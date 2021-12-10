# AWS + Terraform + Jsonnet in perfect harmony

Sonnetry extends Jsonnet with the power of the AWS SDK for Node, and empowers its use with Terraform. All in a simple, easy-to-use way.

## Installation

Sonnetry relies on the `@jahed/terraform` package to provide terraform binaries, but allows you to specify the version by installing it manually. Use the version of Terraform you want as the version for `@jahed/terraform` during installation. To use Terraform v0.15.4 for example, use this command:

```sh
$ npm install @c6fc/sonnetry @jahed/terraform@0.15.4      # Project-local
$ npm install -g @c6fc/sonnetry @jahed/terraform@0.15.4   # Global
```

## Jsonnet extended by the AWS SDK

One of the greatest features of Sonnetry is the ability to consume the AWS SDK for JavaScript directly within Jsonnet. Consider the following Jsonnet file:

```jsonnet
local aws = import 'aws-sdk';  // Import the AWS SDK

{
  'demo.tf.json': {
    output: {
      whoami: {
      	// Prepare an API caller
        value: aws.api(		

            // Using a client for the 'STS' service	
            aws.client('STS'),

            // To call 'getCallerIdentity'
            'getCallerIdentity'

        // Then retrieve the 'Arn' property from the result.
        ).Arn
      }
    }
  }
}
```

When evaluated, you'll see the following in `./render/demo.tf.json:`

```json
{
  "output": {
    "whoami": {
      "value": "arn:aws:iam::123456789012:user/you"
    }
  }
}
````

**Wait, It called sts:getCallerIdentity, then injected the Identity ARN into the Terraform configuration? How is this possible?!**

Sonnetry accomplishes this through two very simple native functions added to Jsonnet:
1. `aws.client( <service_code>, [{ ...params }])`
2. `aws.api( <aws_client>, <sdk_method>, [{ ...params }])`

These perfectly translate to the service codes and methods exposed by the AWS SDK for JavaScript. For example, if we wanted to call `ec2:DescribeVpcs` in `us-west-2`, we could do this:

```jsonnet
local ec2client = aws.client('EC2', { region: "us-west-2" }),
vpcs: aws.api(ec2client, 'describeVpcs')
```

or, as a one-liner:

```jsonnet
vpcs: aws.api(aws.client('EC2', { region: "us-west-2" }), 'describeVpcs')
```

If you don't need to specify any parameters to the API client, you can also just use `aws.call()`:

```jsonnet
identity: aws.call('STS', 'getCallerIdentity')
```

It's that easy! If you want to see more examples, check out the [sonnetry-examples repo on github](https://github.com/c6fc/sonnetry-examples)!


## Project-based state management in S3

Terraform's remote state is critical for long-lived infrastructure or circumstances where multiple individuals are contributing to the architecture. Sonnetry makes it easy to bootstrap a project into a new remote state, and for that state to be used consistently across accounts or security contexts.

This is accomplished through Sonnetry's 'bootstrap()' function:
```jsonnet
local aws = import 'aws-sdk';        // Import the AWS SDK
local sonnetry = import 'sonnetry';  // Import sonnetry

// Create the s3 backend, and return
// a terraform s3 backend configuration
local backend = sonnetry.backend('my-persistent-project');

{
  // Save the backend in the project
  'backend.tf.json': backend

  // Access a property of the backend configuration
  backendBucket:: backend.terraform.backend.s3.bucket
}
```

If the account doesn't have a Sonnetry state bucket, it will be created when the file is evaluated. The bucket is created with the format of `sonnetry-<random_characters>-<unix_timestamp>`, and is automatically configured to block public access and enable versioning.

Applying the configuration will render the following in 'backend.tf.json':
```json
{
    "terraform": {
        "backend": {
            "s3": {
                "bucket": "sonnetry-oszghfzdrx-1637718050",
                "key": "sonnetry/my-persistent-project/terraform.tfstate",
                "region": "us-east-1"
            }
        }
    }
}
```

Sonnetry will always use the same bucket for all projects within an account. As a result, it's important to ensure that different projects use distinct project names.

## Using the command line utility

Sonnetry bundles the `sonnetry` command line utility for ease of use. It can be run depending on how you chose to install it:

```sh
$ npx sonnetry   # Project-local
$ sonnetry       # Global
```

Use the `sonnetry generate` command to parse a Jsonnet file and render the results into `.render` in the local directory. This is great for validating the results before invoking terraform, or if you want to run terraform manually.

```sh
$ npx sonnetry apply terraform.jsonnet
[+] Evaluating terraform.jsonnet into ./render/
./render/demo.tf.json
```

The `sonnetry apply` command starts out the same as `generate`, with the added step of running terraform against the generated configurations in `./render/`.

```sh
$ npx sonnetry apply terraform.jsonnet
[+] Evaluating terraform.jsonnet into ./render/
./render/demo.tf.json

[...]

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

Outputs:

whoami_short = "arn:aws:iam::123456789012:user/you"
[+] Successfully applied
```

## Using the library

If you need more control over your IaC, you can easily import and use the library in your own project.

```javascript
const { Sonnet } = require('@c6fc/sonnetry');

const sonnetry = new Sonnet({
  // The folder to write the configurations into
  renderPath: './render',

  // Whether to delete the *.tf.json files from the renderPath before rendering		
  cleanBeforeRender: true
});

// Render the Jsonnet file, returning a raw object.
const json = await sonnetry.render('terraform.jsonnet');

// Save the most recent render to the renderPath.
sonnetry.write();

// Run `terraform apply` on the rendered files.
sonnetry.apply();
````

## Authenticating to AWS

Authenticating to AWS is a common challenge when working with Terraform, and Sonnetry addresses this beautifully. Sonnetry will always use the same credentials that the AWS CLI would in a given context, automatically determining the AWS credentials to be used in the following order:
1. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` environment variables
2. EC2 instance profile
3. `AWS_PROFILE` environment variable

It also natively supports assumerole profile entries, and will prompt for MFA as appropriate.

```sh
$ export AWS_PROFILE=assumerole_profile_with_mfa
$ npx sonnetry apply terraform.jsonnet
Enter MFA code for arn:aws:iam::123456789012:mfa/you: ******
[+] Successfully assumed role [arn:aws:iam::210987654321:role/Deployment]
[...]
```