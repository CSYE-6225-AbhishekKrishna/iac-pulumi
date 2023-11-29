// Define your GCP project and zone
    const gcpProject = "your-gcp-project";
    const zone = "your-gcp-zone";

    // Create a GCP service account
    const serviceAccount = new gcp.serviceaccount.Account("gcpcli", {
      name: "gcpcli",
      accountId: "csye6225-webapp",
      project: gcpProject,
    });

    // Create an SNS topic
    const snsTopic = new aws.sns.Topic("my-sns-topic", {
      name: "my-sns-topic",
    });

    // Attach policy to EC2 SNS role
    const ec2SNSPolicy = new aws.iam.RolePolicy("EC2SNSTopicPolicy", {
      role: ec2Role.id, // Ensure ec2Role is defined
      policy: snsTopic.arn.apply(
        (arn) => pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "sns:Publish",
                "Resource": "${arn}"
            }
        ]
    }`
      ),
    });

    // Create a GCS bucket
    const bucket = new gcp.storage.Bucket("my-gcs-bucket", {
      name: "my-gcs-bucket",
      location: zone,
      uniformBucketLevelAccess: true,
      forceDestroy: true,
      project: gcpProject,
      publicAccessPrevention: "enforced",
      versioning: {
        enabled: true,
      },
      storageClass: "STANDARD",
    });

    // Permission for bucket to service account
    const objectAdminPermission = new gcp.storage.BucketIAMBinding(
      "objectAdminPermission",
      {
        bucket: bucket.name,
        members: [pulumi.interpolate`serviceAccount:${serviceAccount.email}`],
        role: "roles/storage.objectAdmin",
      }
    );

    // Define the DynamoDB table
    const dynamoDBTable = new aws.dynamodb.Table("my-dynamodb-table", {
      name: "my-dynamodb-table",
      attributes: [
        { name: "id", type: "S" },
        { name: "timestamp", type: "N" },
      ],
      billingMode: "PAY_PER_REQUEST",
      hashKey: "id",
      rangeKey: "timestamp",
    });

    // Define an IAM role for the Lambda function to consume from SNS
    const lambdaSNSRole = new aws.iam.Role("LambdaSNSRole", {
      assumeRolePolicy: pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Action": "sts:AssumeRole",
                "Effect": "Allow",
                "Principal": {
                    "Service": "lambda.amazonaws.com",
                },
            },
        ],
    }`,
    });

    // Attach a policy to the Lambda SNS role allowing it to consume messages from the SNS topic
    const lambdaSNSPolicy = new aws.iam.RolePolicy("LambdaSNSTopicPolicy", {
      role: lambdaSNSRole.id,
      policy: snsTopic.arn.apply(
        (arn) => pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "sns:Subscribe",
                "Resource": "${arn}",
            },
            {
                "Effect": "Allow",
                "Action": [
                    "sns:ConfirmSubscription",
                    "sns:Receive",
                ],
                "Resource": "${arn}",
            },
        ],
    }`
      ),
    });

    // Attach the AWSLambdaBasicExecutionRole managed policy to the Lambda role
    const lambdaRolePolicyAttachment = new aws.iam.RolePolicyAttachment(
      "lambdaRolePolicyAttachment",
      {
        role: lambdaSNSRole.name,
        policyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      }
    );

    // Create Lambda function
    const lambdaFunction = new aws.lambda.Function("my-lambda-function", {
      name: "my-lambda-function",
      runtime: aws.lambda.Runtime.NodeJS14x,
      handler: "index.handler",
      role: lambdaSNSRole.arn,
      code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("./path/to/your/lambda/code"),
      }),
      environment: {
        variables: {
          GCSBucketName: bucket.name,
          GCSAccessKeys: "your-access-keys", // Replace with your actual access keys
          serviceAccountPvtKey: "your-service-account-key-decoded", // Replace with your actual private key
          project: gcpProject,
          accountEmail: serviceAccount.email,
          DYNAMODB_TABLE_NAME: dynamoDBTable.name,
          EMAIL_API_KEY: "ffb00eeafe5baf861de1102fe3fe9b58-5d2b1caa-94c15328",
        },
      },
    });

    // Add SNS trigger to Lambda function
    const lambdaSnsPermission = new aws.lambda.Permission(
      "lambdaSnsPermission",
      {
        action: "lambda:InvokeFunction",
        function: lambdaFunction.arn,
        principal: "sns.amazonaws.com",
        sourceArn: snsTopic.arn,
      }
    );

    // Subscribe Lambda to SNS
    const snsSubscription = new aws.sns.TopicSubscription(
      "lambda-subscription",
      {
        name: "lambda-subscription",
        topic: snsTopic,
        protocol: "lambda",
        endpoint: lambdaFunction.arn,
      }
    );

    // Grant PutItem permission on the DynamoDB table to the Lambda role
    const dynamoDBTablePolicy = new aws.iam.RolePolicy("dynamoDBTablePolicy", {
      role: lambdaSNSRole.name,
      policy: dynamoDBTable.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["dynamodb:PutItem"],
              Resource: arn,
            },
          ],
        })
      ),
    });

    // Replace these with your Mailgun API key and domain
    const apiKey = "your-mailgun-api-key";
    const domain = "your-mailgun-domain";

    // Create a Mailgun instance with your API key and domain
    const mg = require("mailgun-js")({ apiKey, domain });

    // Define the email data
    const data = {
      from: "CSYE6225 Submission notifications@bulchandani.xyz",
      to: "bulchandani.s@northeastern.edu",
      subject: "Assignment submission received",
      text: "Your submission was successfully received and verified. Thank you.",
    };

    // Send the email
    mg.messages().send(data, (error, body) => {
      if (error) {
        console.error("Error sending email:", error);
      } else {
        console.log("Email sent:", body);
      }
    });
  });
});

////////////////////////////////

const rolePolicyAttachment = new aws.iam.RolePolicyAttachment("rolePolicyAttachment", {
  role: lambdaRole.name,
  policyArn: lambdaPolicy.arn,
});

const snsFullAccessPolicyAttachment = new aws.iam.RolePolicyAttachment("snsFullAccessPolicyAttachment", {
  role: lambdaRole.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
});

const CloudwatchPolicyAttachment = new aws.iam.RolePolicyAttachment("CloudwatchPolicyAttachment", {
  role: lambdaRole.name,
  policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

//////////////////////////
// Create the Lambda function
// const lambdaFunction = new aws.lambda.Function("lambdaFunction", {
//     name: 'my-lambda-funtion',
//     runtime: aws.lambda.Runtime.NodeJS14dX,
//     handler: "index.handler",
//     code: new pulumi.asset.AssetArchive({
//         ".": new pulumi.asset.FileArchive("C:/CSYE6225_Cloud/Assignment_9/serverless"),
//     }),
//     role: lambdaRole.arn,
//     environment: {
//         variables: {
//             // Add any environment variables you need
//         },
//     },
//     tracingConfig: {
//         mode: "Active", // Enable AWS X-Ray tracing for the Lambda function
//     },
//     timeout: 10, // Set an appropriate timeout value
//     memorySize: 128, // Set an appropriate memory size
// });

// // Add CloudWatch log group
// const lambdaLogGroup = new aws.cloudwatch.LogGroup("lambdaLogGroup", {
//     name: `/aws/lambda/${lambdaFunction.name}`,
//     retentionInDays: 7, // Adjust as needed
// });

// // Add CloudWatch log stream
// const lambdaLogStream = new aws.cloudwatch.LogStream("lambdaLogStream", {
//     name: pulumi.interpolate`${lambdaFunction.name}-${new Date().toISOString()}`,
//     logGroupName: lambdaLogGroup.name,
// });

// // Add CloudWatch log subscription filter (optional, if you want to stream logs to another service like AWS Elasticsearch)
// const lambdaLogSubscriptionFilter = new aws.cloudwatch.LogSubscriptionFilter("lambdaLogSubscriptionFilter", {
//     logGroup: lambdaLogGroup.name,  // Corrected property name
//     filterPattern: "",
//     destinationArn: "arn:aws:logs:region:account-id:destination-arn", // Adjust as needed
//     roleArn: "arn:aws:iam::account-id:role/role-name", // Adjust as needed
//     distribution: "ByLogStream",
// },{dependsOn: lambdaLogStream});


// // Subscribe the Lambda function to the CloudWatch log stream
// const lambdaLogEventSource = new aws.lambda.EventSourceMapping("lambdaLogEventSource", {
//     eventSourceArn: lambdaLogStream.arn,
//     functionName: lambdaFunction.name,
//     batchSize: 1,
//     startingPosition: "LATEST",
// });