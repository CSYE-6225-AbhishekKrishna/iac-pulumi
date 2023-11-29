
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as gcp from "@pulumi/gcp";

import * as fs from "fs";

const config = new pulumi.Config();
 

// Base CIDR block
const baseCidrBlock = config.require("baseCidrBlock");


const amiId = config.require("amiId");
const destinationCidrBlock = config.require("destinationCidrBlock");
 

// Get the availability zones for the region
const complete_availabilityZones = pulumi.output(aws.getAvailabilityZones({
    state: "available"
}));

 

const availabilityZones = complete_availabilityZones.apply(az => az.names.slice(0, 3));


// Function to calculate the new subnet mask
function calculateNewSubnetMask(vpcMask: number, numSubnets: number): number {
    const bitsNeeded = Math.ceil(Math.log2(numSubnets));
    const newSubnetMask = vpcMask + bitsNeeded;
    return newSubnetMask;
}

 

function ipToInt(ip: string): number {
    const octets = ip.split('.').map(Number);
    return (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}


function intToIp(int: number): string {
    return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

 

function generateSubnetCidrBlocks(baseCidrBlock: string, numSubnets: number): string[] {
    const [baseIp, vpcMask] = baseCidrBlock.split('/');
    const newSubnetMask = calculateNewSubnetMask(Number(vpcMask), numSubnets);
    const subnetSize = Math.pow(2, 32 - newSubnetMask);
    const subnetCidrBlocks = [];
    for (let i = 0; i < numSubnets; i++) {
        const subnetIpInt = ipToInt(baseIp) + i * subnetSize;
        const subnetIp = intToIp(subnetIpInt);
        subnetCidrBlocks.push(`${subnetIp}/${newSubnetMask}`);
    }
    return subnetCidrBlocks;
}

 

 

// Create a VPC
const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: baseCidrBlock,
});

 

// Create subnets
const subnetCidrBlocks = generateSubnetCidrBlocks(baseCidrBlock, 6);  // Assuming 3 public and 3 private subnets

 

const publicSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`public-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index],
            availabilityZone: az,
            mapPublicIpOnLaunch: true,
            tags: { Name: `public-subnet-${az}` }
        });
        return subnet;
    })
);

 

const privateSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`private-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index + 3],  // Offset by 3 to use different CIDR blocks for private subnets
            availabilityZone: az,
            tags: { Name: `private-subnet-${az}` }
        });
        return subnet;
    })
);

 

 

// Create an Internet Gateway
const internetGateway = new aws.ec2.InternetGateway("my-internet-gateway", {
    vpcId: vpc.id,
    tags: { Name: "my-internet-gateway" },
});

 

// Create a public route table
const publicRouteTable = new aws.ec2.RouteTable("public-route-table", {
  vpcId: vpc.id,
  tags: { Name: "public-route-table" },
});
 

// Attach all public subnets to the public route table
publicSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`public-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: publicRouteTable.id,
        });
    });
});

 

// Create a private route table
const privateRouteTable = new aws.ec2.RouteTable("private-route-table", {
    vpcId: vpc.id,
    tags: { Name: "private-route-table" },
});

 

// Attach all private subnets to the private route table
privateSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`private-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: privateRouteTable.id,
        });
    });
});

 

// Create a public route in the public route table
new aws.ec2.Route("public-route", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: destinationCidrBlock,
    gatewayId: internetGateway.id,
});

 

// Export subnet IDs
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.apply(subnets => subnets.map(subnet => subnet.id));
export const privateSubnetIds = privateSubnets.apply(subnets => subnets.map(subnet => subnet.id));

export const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("loadbalancer-security-group", {
    description: "Security group for Load Balancer",
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "Csye6255-loadbalancer-security-group" },
});

// Create a new security group
export const applicationSecurityGroup = new aws.ec2.SecurityGroup("applicationSecurityGroup", {
    description: "Enable access to application",
    tags: {
        Name: "Csye6255-abhishek-security group",
    },
    vpcId: vpc.id,
    ingress: [
        // SSH access
        {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["0.0.0.0/0"]

        },
        {
            protocol: "tcp",
            fromPort: 3001,
            toPort: 3001,   
            securityGroups: [loadBalancerSecurityGroup.id],
        }
    ],
    egress: [{
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    }]
},{dependsOn: loadBalancerSecurityGroup });

let rawKeyContent: string;
try {
    rawKeyContent = fs.readFileSync("/Users/abhik/.ssh/myawskey.pub", 'utf8').trim();
} catch (error) {
    pulumi.log.error("Error reading the public key file.");
    throw error;
}

const keyParts = rawKeyContent.split(" ");
const publicKeyContent = keyParts.length > 1 ? `${keyParts[0]} ${keyParts[1]}` : rawKeyContent;

const keyPair = new aws.ec2.KeyPair("mykeypair", {
    publicKey: publicKeyContent,
}); 

const keyPairName = keyPair.id.apply(id => id);


// Define a DB security group
const dbSecurityGroup = new aws.ec2.SecurityGroup("dbSecurityGroup", {
    vpcId: vpc.id, // Use the VPC you've defined earlier
    description: "Security group for RDS instances",
});

// Define ingress rule to allow traffic on port 5432 from the application security group
new aws.ec2.SecurityGroupRule("dbIngressRule", {
    securityGroupId: dbSecurityGroup.id,
    type: "ingress",
    fromPort: 5432,
    toPort: 5432,
    protocol: "tcp",
    sourceSecurityGroupId: applicationSecurityGroup.id,
});


const rdsParameterGroupName = "csye6225-postgres15-param-group"; // parameter group name

const rdsParameterGroup = new aws.rds.ParameterGroup(rdsParameterGroupName, {
    family: "postgres15", // PostgreSQL version
    description: "Custom parameter group for PostgreSQL 15", 
});

// Private subnet group created with privateSubnets[0].id
const dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
    description: "DB subnet group for RDS",
    subnetIds: [ privateSubnets[0].id, privateSubnets[1].id ],
});

export const dbSubnetGroupName = dbSubnetGroup.name;

const rdsInstance = new aws.rds.Instance("csye6225-rds-instance-postgres", {
    allocatedStorage: 20,
    storageType: "gp2",
    engine: "postgres", 
    engineVersion: "15", 
    instanceClass: "db.t3.micro", 
    dbName: "postgres",
    username: "postgres",
    password: "Pa55w0rd",
    skipFinalSnapshot: true,
    vpcSecurityGroupIds: [dbSecurityGroup.id], 
    dbSubnetGroupName: dbSubnetGroup.name, 
    parameterGroupName: rdsParameterGroup.name, // Attach the parameter group
    publiclyAccessible: false,
});

// Define the IAM role with CloudWatchAgentServer policy
const role = new aws.iam.Role("CloudwatchEC2role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
});

// Create a Google Cloud Storage bucket
const bucket = new gcp.storage.Bucket("webapp-abhishek-krishna", {
    location: "US",
});

// Create a Google Service Account
const serviceAccount = new gcp.serviceaccount.Account("csye6225-abhishek", {
    accountId: "csye6225-abhishek",
    displayName: "csye6225-abhishek",
});

const defaultProject = config.require("project"); 

// Assign necessary roles to the service account
const storageAdminBinding = new gcp.projects.IAMBinding("storage-admin-binding", {
    project: defaultProject,
    role: "roles/storage.admin",
    members: [serviceAccount.email.apply(email => `serviceAccount:${email}`)],
});

// Create Access Keys for the Service Account
const serviceAccountKey = new gcp.serviceaccount.Key("csye6225-abhishek-account-key", {
    serviceAccountId: serviceAccount.name,
    publicKeyType: "TYPE_X509_PEM_FILE",
});

// Export the bucket name and service account key
export const bucketName = bucket.name;
export const serviceAccountKeyEncoded = pulumi.secret(
    serviceAccountKey.privateKey.apply(key => Buffer.from(key, 'base64').toString('utf-8'))
);

// Attach the CloudWatchAgentServer policy to the role
const policyAttachment = new aws.iam.RolePolicyAttachment("CloudWatchAgentServerPolicyAttachment", {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

// Create an SNS Topic
const snsTopic = new aws.sns.Topic("sns-topic", {
    displayName: "SNS-Topic", 
});

// Export the SNS topic ARN
export const snsTopicArn = snsTopic.arn;

const snsEC2FullAccessPolicyAttachment = new aws.iam.RolePolicyAttachment("snsEC2FullAccessPolicyAttachment", {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
});

const instanceProfile = new aws.iam.InstanceProfile("ec2InstanceProfile", {
    role: role.name,
});

// Attach policy to EC2 SNS role
const ec2SNSPolicy = new aws.iam.RolePolicy("EC2SNSTopicPolicy", {
    role: role.name, // Ensure ec2Role is defined
    policy: snsTopic.arn.apply((arn) => pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "sns:Publish",
                "Resource": "${arn}"
            }
        ]
    }`),
});

// Create an IAM role for the Lambda function
const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: pulumi.output({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
        }],
    }),
});

const lambdaPolicy = new aws.iam.Policy("lambdaPolicy", {
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ses:SendEmail",
                    "ses:SendRawEmail"
                ],
                Resource: "*" // Specify your SES resource ARN if you want to restrict to specific resources
            },
            {
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:Scan",
                    "dynamodb:Query"
                ],
                Resource: "*" // Replace with your DynamoDB table ARN
            },
            {
                Effect: "Allow",
                Action: [
                    "sts:AssumeRole"
                ],
                Resource: "*" // Specify the ARN of the GCP service account role here
            }
        ],
    }),
});

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

//Create DynamoDB instance
const table = new aws.dynamodb.Table("email-list-table", {
    attributes: [
        { name: "id", type: "S" }, // Composite primary key (email+timestamp)
        { name: "email", type: "S" },
        { name: "timestamp", type: "S" },
        { name: "status", type: "S" }
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    globalSecondaryIndexes: [
        {
        name: "EmailIndex",
        hashKey: "email",
        projectionType: "ALL", 
        },
        {
            name: "timestampIndex",
            hashKey: "timestamp",
            projectionType: "ALL", 
        },
        {
            name: "statusIndex",
            hashKey: "status",
            projectionType: "ALL", 
        }
]
});

const serverlesspath = config.require("serverlesspath");
// Create the Lambda function
const lambdaFunction = new aws.lambda.Function("lambdaFunction", {
    name: 'my-lambda-funtion',
    runtime: aws.lambda.Runtime.NodeJS18dX,
    handler: "index.handler",
    code: new pulumi.asset.FileArchive(serverlesspath),
    role: lambdaRole.arn,

    environment: {
        variables: {
            GCP_SERVICE_ACCOUNT_KEY: serviceAccountKeyEncoded,
            BUCKET_NAME: bucketName,
            TABLE_NAME: table.name,
            MAILGUN_API_KEY: config.require("mailgunApiKey"),
            MAILGUN_DOMAIN: config.require("mailgunDomain"),        
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

// Subscribe the Lambda function to the SNS topic
const snsSubscription = new aws.sns.TopicSubscription("snsSubscription", {
    protocol: "lambda",
    endpoint: lambdaFunction.arn,
    topic: snsTopic.arn,
});


const userData = pulumi.interpolate`#!/bin/bash
# Define the file path
env_file="/opt/csye6225/webapp/.env"

# Check if the file exists; create or append accordingly
if [ -f "$env_file" ]; then
    echo "DB_HOST=${rdsInstance.address}" >> "$env_file"
    echo "DB_USERNAME=${rdsInstance.username}" >> "$env_file"
    echo "DB_PASSWORD=${rdsInstance.password}" >> "$env_file"
    echo "TOPIC_ARN=${snsTopicArn}" >> "$env_file"
else
    echo "DB_HOST=${rdsInstance.address}" > "$env_file"
    echo "DB_USERNAME=${rdsInstance.username}" >> "$env_file"
    echo "DB_PASSWORD=${rdsInstance.password}" >> "$env_file"
    echo "TOPIC_ARN=${snsTopicArn}" >> "$env_file"
fi

# Fetch the latest CloudWatch agent configuration and start the agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a start

sudo systemctl start myapp-systemd.service

sudo chown -R csye6225:csye6225 /opt/csye6225/webapp

`;

export const alb = new aws.lb.LoadBalancer("app-lb", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [loadBalancerSecurityGroup.id],
    subnets: publicSubnets.apply(subnets => subnets.map(subnet => subnet.id)),
    enableDeletionProtection: false,
});

const launchTemplate = new aws.ec2.LaunchTemplate("myLaunchTemplate", {
    name: "my-launch-template",
    imageId:amiId,
    description: "My Launch Template",
    blockDeviceMappings: [{
        deviceName: "/dev/xvda",
        ebs: {
            volumeSize: 25,
            volumeType: "gp2",
            deleteOnTermination: 'true',
        },
    }],
    instanceType: "t2.micro",
    keyName: keyPairName,
    networkInterfaces: [{
        deviceIndex: 0,
        associatePublicIpAddress:  'true',
        securityGroups: [applicationSecurityGroup.id],
        subnetId: publicSubnets[0].id,
    }],
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "Csye6255-Abhishek",
        },
    }],
    userData:  pulumi.interpolate`${userData.apply((s) =>
        Buffer.from(s).toString("base64")
      )}`,
    iamInstanceProfile: {
        name: instanceProfile.name,
    },
    disableApiTermination:false
},{dependsOn: [keyPair,rdsInstance]});

const targetGroup = new aws.alb.TargetGroup("targetGroup",{
    port:3001,
    protocol:'HTTP',
    vpcId:vpc.id,
    targetType:'instance',
    healthCheck:{
      enabled:true,
      path:'/healthz',
      protocol:'HTTP',
      port:'3001',
      timeout:25
  
    }
  })

const listener = new aws.alb.Listener("listener",{
   loadBalancerArn:alb.arn,
   port:80,
   defaultActions:[{
     type:'forward',
     targetGroupArn:targetGroup.arn
   }]
 })


   // Create an Auto Scaling group
const autoScalingGroup = new aws.autoscaling.Group("myAutoScalingGroup", {
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest", // Use the latest version of the launch template
    },
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 1,
    targetGroupArns:[targetGroup.arn],
    vpcZoneIdentifiers: [publicSubnets[0].id,publicSubnets[1].id,publicSubnets[2].id], // Subnet IDs where instances will be launched // Get availability zones
    tags: [{
        key: "Name",
        value: "Csye6255-Abhishek",
        propagateAtLaunch: true,
    }],
    // Add your other properties like cooldown, health check, etc. here
});

// Define scaling policies
const scaleUpPolicy = new aws.autoscaling.Policy("scaleUpPolicy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    policyType: "SimpleScaling",
    scalingAdjustment: 1, // Increment by 1
    cooldown: 60,
});

const scaleDownPolicy = new aws.autoscaling.Policy("scaleDownPolicy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    policyType: "SimpleScaling",
    scalingAdjustment: -1, // Decrement by 1
    cooldown: 300,
});

// CloudWatch Alarm for Scale Up
const scaleUpAlarm = new aws.cloudwatch.MetricAlarm("scaleUpAlarm", {
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 5, // Adjust as needed
    alarmActions: [scaleUpPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

// CloudWatch Alarm for Scale Down
const scaleDownAlarm = new aws.cloudwatch.MetricAlarm("scaleDownAlarm", {
    comparisonOperator: "LessThanOrEqualToThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 3, 
    alarmActions: [scaleDownPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});
const hzName = config.require("hzname");
const hostedZone = aws.route53.getZone({ name: hzName  }, { async: true });
// .then(zone => zone.id);

// Create a new A record after the EC2 instance and hosted zone ID are available
hostedZone.then(zoneId => {
    new aws.route53.Record("Record", {
        zoneId: zoneId.id,
        name: zoneId.name,
        type: "A",
        aliases:[
            {
              name:alb.dnsName,
              zoneId:alb.zoneId,
              evaluateTargetHealth:true
            }]
    });
});

export const rdsParameterGroupId = rdsParameterGroup.id;
// export const ec2InstanceId = instance.id;


