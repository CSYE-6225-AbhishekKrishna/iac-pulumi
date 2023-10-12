
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";


// Create a VPC
const config = new pulumi.Config();
const vpcCidr = config.require("vpcCidr");
const vpcName = config.require("vpcName");
const igwName = config.require("igwName");
const publicSubnetPrefix = config.require("publicSubnetPrefix");
const privateSubnetPrefix = config.require("privateSubnetPrefix");
const publicSubnetAssociation = config.require("publicSubnetAssociation");
const privateSubnetAssociation = config.require("privateSubnetAssociation");
const publicRouteTableName = config.require("publicRouteTableName");
const privateRouteTableName = config.require("privateRouteTableName");
const destinationCidrBlock = config.require("destinationCidrBlock");

const publicCidrBlocks = JSON.parse(config.require("publicCidrBlocks"));
const privateCidrBlocks = JSON.parse(config.require("privateCidrBlocks"));


const vpc = new aws.ec2.Vpc("myVpc", {
    cidrBlock: vpcCidr,
    tags: { Name: vpcName },
});

// Fetch available availability zones
const availabilityZones = pulumi.output(aws.getAvailabilityZones({ state: "available" })).names;

const publicSubnets: aws.ec2.Subnet[] = [];
const privateSubnets: aws.ec2.Subnet[] = [];

availabilityZones.apply((azs) => {
    const numSubnets = Math.min(azs.length, 3);

    for (let i = 0; i < numSubnets; i++) {
        const publicSubnet = new aws.ec2.Subnet(`${publicSubnetPrefix}${i}`, {
            vpcId: vpc.id,
            cidrBlock: publicCidrBlocks[i],
            availabilityZone: azs[i],
            mapPublicIpOnLaunch: true,
            tags: { Name: `${publicSubnetPrefix}${i}` }
        });

        publicSubnets.push(publicSubnet);

        const privateSubnet = new aws.ec2.Subnet(`${privateSubnetPrefix}${i}`, {
            vpcId: vpc.id,
            cidrBlock: privateCidrBlocks[i],
            availabilityZone: azs[i],
            tags: { Name: `${privateSubnetPrefix}${i}` },
        });

        privateSubnets.push(privateSubnet);

        // Create route table associations
        new aws.ec2.RouteTableAssociation(`${publicSubnetAssociation}${i}`, {
            subnetId: publicSubnet.id,
            routeTableId: publicRouteTable.id,
        });

        new aws.ec2.RouteTableAssociation(`${privateSubnetAssociation}${i}`, {
            subnetId: privateSubnet.id,
            routeTableId: privateRouteTable.id,
        });
    }
});

// Create an Internet Gateway and attach it to the VPC
const internetGateway = new aws.ec2.InternetGateway("myInternetGateway", {
    vpcId: vpc.id,
    tags: { Name: `${igwName}` },
});

// Create a public route table
const publicRouteTable = new aws.ec2.RouteTable(`${publicRouteTableName}`, {
    vpcId: vpc.id,
    tags: { Name: `${publicRouteTableName}` },
});

// Create a private route table
const privateRouteTable = new aws.ec2.RouteTable(`${privateRouteTableName}`, {
    vpcId: vpc.id,
    tags: { Name: `${privateRouteTableName}` },
});

// Create a public route in the public route table for Internet access
new aws.ec2.Route("publicRoute", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: `${destinationCidrBlock}`,
    gatewayId: internetGateway.id,
});

// Export VPC and Subnet IDs for later use
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.map(subnet => subnet.id);
export const privateSubnetIds = privateSubnets.map(subnet => subnet.id);

