
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

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

const applicationSecurityGroup = new aws.ec2.SecurityGroup("applicationSecurityGroup", {
    vpcId: vpc.id,
    description: "Security group for web application instances",
});

// Define ingress rules for the security group
const ingressRules = [
    {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow SSH from anywhere
    },
    {
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTP from anywhere
    },
    {
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTPS from anywhere
    },
    // Application port 3001
    {
        fromPort: 3001,
        toPort: 3001,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTPS from anywhere
    },
];

ingressRules.forEach((rule, index) => {
    new aws.ec2.SecurityGroupRule(`appSecurityGroupRule${index}`, {
        securityGroupId: applicationSecurityGroup.id,
        type: "ingress",
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrBlocks: rule.cidrBlocks,
    });
});


const egressRules = [
    {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    },
];

egressRules.forEach((rule, index) => {
    new aws.ec2.SecurityGroupRule(`appSecurityGroupEgressRule${index}`, {
        securityGroupId: applicationSecurityGroup.id,
        type: "egress",
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrBlocks: rule.cidrBlocks,
    });
});


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
    // name: "csye6225",
    username: "postgres",
    password: "Pa55w0rd",
    skipFinalSnapshot: true,
    vpcSecurityGroupIds: [dbSecurityGroup.id], 
    dbSubnetGroupName: dbSubnetGroup.name, 
    parameterGroupName: rdsParameterGroup.name, // Attach the parameter group
    publiclyAccessible: false,
});

const userData = pulumi.interpolate`#!/bin/bash
# Define the file path
env_file="/home/admin/webapp/.env"

# Check if the file exists; create or append accordingly
if [ -f "$env_file" ]; then
    echo "DB_HOST=${rdsInstance.address}" >> "$env_file"
    echo "DB_USERNAME=${rdsInstance.username}" >> "$env_file"
    echo "DB_PASSWORD=${rdsInstance.password}" >> "$env_file"
else
    echo "DB_HOST=${rdsInstance.address}" > "$env_file"
    echo "DB_USERNAME=${rdsInstance.username}" >> "$env_file"
    echo "DB_PASSWORD=${rdsInstance.password}" >> "$env_file"
    echo "${rdsInstance.endpoint}"
fi
`;

const instance = new aws.ec2.Instance("myEc2Instance", {
    ami: amiId, 
    instanceType: "t2.micro",
    vpcSecurityGroupIds: [applicationSecurityGroup.id], 
    subnetId: publicSubnets[0].id, 
    rootBlockDevice: {
        volumeSize: 25,
        volumeType: "gp2",
        deleteOnTermination: true,
    },
    disableApiTermination: false,
    keyName: keyPairName,
    userData: userData,
    tags: { Name: "MyEC2Instance" }, 
});


export const rdsParameterGroupId = rdsParameterGroup.id;
export const ec2InstanceId = instance.id;
