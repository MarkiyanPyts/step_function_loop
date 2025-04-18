import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

export class StepFunctionJobStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda function to perform the "job"
    const jobLambda = new lambda.Function(this, 'JobHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromInline(`
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        exports.handler = async (event) => {
          console.log("Event received:", event);

          // Simulate job processing
          const counter = event.counter ?? 0;

          // Logic to determine job completion
          const isComplete = counter >= 5;

          // simulate lengthy job processing with a 5-second delay
          await sleep(5000);

          return { 
            counter: counter + 1,
            isComplete
          };
        };
      `),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
    });

    // Define Lambda invocation task
    const invokeJob = new tasks.LambdaInvoke(this, 'Invoke Job Lambda', {
      lambdaFunction: jobLambda,
      outputPath: '$.Payload', // pass Lambda response as next state input
    });

    // Define choice to check if job is complete
    const jobCompleteChoice = new sfn.Choice(this, 'Is Job Complete?');

    // Define state machine
    const jobDefinition = invokeJob
      .next(jobCompleteChoice
        .when(sfn.Condition.booleanEquals('$.isComplete', true), new sfn.Succeed(this, 'Job Succeeded'))
        .otherwise(invokeJob));

    // Create state machine
    new sfn.StateMachine(this, 'JobStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(jobDefinition),
      timeout: cdk.Duration.minutes(15),
      stateMachineType: sfn.StateMachineType.EXPRESS,//sfn.StateMachineType.STANDARD for long running jobs up to 1 year
    });
  }
}
